import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "./fixtures";

async function loginAdmin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("demo-login-demo-admin").click();
  await page.waitForURL("**/admin");
}

test.describe.configure({ mode: "serial" });

test("overview answers the head-office questions", async ({ page }) => {
  await loginAdmin(page);
  for (const id of ["sites", "contractors", "workers", "present", "absent", "pending"]) {
    await expect(page.getByTestId(`tile-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId("tile-sites")).toContainText("4");
  await expect(page.getByTestId("tile-contractors")).toContainText("4");
  await expect(page.getByText("Plants with incomplete attendance today")).toBeVisible();
  const table = page.getByTestId("contractor-summary");
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByText("Not configured")).toBeVisible();
});

test("admin adds a worker who appears on the plant register, then deactivates them", async ({ page }) => {
  await loginAdmin(page);
  await page.goto("/admin/contractors/c2");
  await page.getByTestId("add-worker").click();
  await page.getByLabel("Full name").fill("Playwright Testworker");
  await page.getByLabel("Plant", { exact: true }).selectOption({ label: "LED Rope Light Plant (Demo)" });
  await page.getByTestId("save-worker").click();
  await expect(page.getByText(/Playwright Testworker added as W-\d{5}/)).toBeVisible();
  await expect(page.getByTestId("worker-admin-list").getByText("Playwright Testworker")).toBeVisible();

  await page.goto("/admin/attendance?tab=register&project=p2&contractor=c2");
  await expect(page.locator('[data-worker="Playwright Testworker"]')).toBeVisible();
  await page.goto("/admin/attendance?tab=register&project=p1&contractor=c2");
  await expect(page.locator('[data-worker="Playwright Testworker"]')).toHaveCount(0);

  await page.goto("/admin/contractors/c2");
  await page.getByRole("button", { name: "Actions for Playwright Testworker" }).click();
  await page.getByRole("menuitem", { name: "Deactivate" }).click();
  await page.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByText("Worker deactivated")).toBeVisible();
  await expect(page.getByTestId("worker-admin-list").getByText("Playwright Testworker")).toHaveCount(0);
});

test("payment rule setup creates a version and replaces 'Not configured'", async ({ page }) => {
  await loginAdmin(page);
  await page.goto("/admin/contractors/c4?tab=rules");
  await expect(page.getByTestId("current-rule")).toHaveText("Not configured");
  await page.getByTestId("new-rule").click();
  await page.getByLabel("Rate per full day (₹)").fill("555");
  await page.getByTestId("save-rule").click();
  await expect(page.getByText("Payment rule version 1 saved")).toBeVisible();
  await expect(page.getByTestId("current-rule")).toContainText("₹555 per day");
});

test("monthly Excel export reconciles with the on-screen report", async ({ page }) => {
  await loginAdmin(page);
  await page.goto("/admin/attendance?tab=report");
  const summaryText = await page.getByText(/present days ·/).innerText();
  const present = Number(/(\d+) present days/.exec(summaryText)![1]);
  const amount = Number(/Est\. ₹([\d,]+\.\d{2})/.exec(summaryText)![1].replace(/,/g, ""));

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-xlsx").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^attendance_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.xlsx$/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile((await download.path())!)) as unknown as ArrayBuffer);
  expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Plant-wise", "Attendance"]);

  let grandPresent: unknown = null;
  let grandAmount: unknown = null;
  wb.getWorksheet("Summary")!.eachRow((r) => {
    if (r.getCell(1).value === "ALL CONTRACTORS") {
      grandPresent = r.getCell(4).value;
      grandAmount = r.getCell(11).value;
    }
  });
  expect(grandPresent).toBe(present);
  expect(grandAmount).toBe(amount);

  let presentRows = 0;
  const attendance = wb.getWorksheet("Attendance")!;
  const statusCol = (attendance.getRow(1).values as string[]).indexOf("Status");
  attendance.eachRow((r, i) => {
    if (i > 1 && r.getCell(statusCol).value === "Present") presentRows++;
  });
  expect(presentRows).toBe(present);
});

test("change log shows bulk vs individual entries", async ({ page }) => {
  await loginAdmin(page);
  await page.goto("/admin/attendance?tab=log");
  const log = page.getByTestId("audit-log");
  await expect(log.getByText("Bulk confirmed").first()).toBeVisible();
  await expect(log.getByText("Individually entered").first()).toBeVisible();
});

test("contractor photo upload is resized in the browser and shown on the card", async ({ page }) => {
  await loginAdmin(page);
  await page.goto("/admin/contractors/c3");
  await expect(page.getByAltText(/photo$/)).toHaveCount(0);
  await page.getByTestId("photo-input").setInputFiles("public/icon-512.png");
  await expect(page.getByText("Photo updated")).toBeVisible();
  await expect(page.getByAltText("Sahyog Contract Services (Demo) photo")).toBeVisible();
  await page.goto("/admin/contractors");
  await expect(page.getByAltText("Sahyog Contract Services (Demo) photo")).toBeVisible();
});

test("admin adds an operator, grants one plant, and the operator sees only that plant", async ({ page }) => {
  await loginAdmin(page);
  await page.goto("/admin/plants?tab=operators");
  await page.getByRole("button", { name: "Add operator" }).click();
  await page.getByLabel("Name").fill("Test Plant Operator");
  await page.getByLabel("Email").fill("test.operator@demo.invalid");
  await page.getByRole("dialog").getByRole("button", { name: "Add operator" }).click();
  await expect(page.getByText("Operator added")).toBeVisible();
  const card = page.locator("li", { hasText: "test.operator@demo.invalid" });
  await card.getByLabel("Quad & Signalling Plant (Demo)").check();
  await expect(page.getByText("Access granted")).toBeVisible();

  await page.getByTestId("user-menu").click();
  await page.getByRole("menuitem", { name: "Switch demo user" }).click();
  await page.waitForURL("**/login");
  await page.getByRole("button", { name: /Test Plant Operator/ }).click();
  await page.waitForURL("**/attendance");
  // Auto-waiting: the register streams in after its loading skeleton.
  await expect(page.getByTestId("project-select").locator("option")).toHaveText(["Quad & Signalling Plant (Demo) — Unit 4 (Demo)"]);
});

test("company defaults and plant overrides drive the register", async ({ page }) => {
  await loginAdmin(page);
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page.waitForURL("**/admin/settings");
  await expect(page.getByTestId("company-suggestedCheckIn")).toHaveText("None (operators enter the time)");

  // Company default: a suggested IN for every plant that does not override it (Quad & Signalling, p4).
  await page.getByTestId("edit-company").click();
  await page.locator("#pol-suggestedCheckIn").fill("08:30");
  await page.getByTestId("policy-save").click();
  await expect(page.getByText(/Saved as version 2/)).toBeVisible();
  await expect(page.getByTestId("company-suggestedCheckIn")).toHaveText("08:30 AM");
  await page.goto("/admin/attendance?tab=register&project=p4");
  // (The operator tests may already have marked everyone here, so check the register's setting, not a row.)
  await expect(page.getByTestId("register")).toHaveAttribute("data-suggested-in", "08:30");

  // Plant override for Quad & Signalling only.
  await page.goto("/admin/settings?plant=p4");
  const form = page.getByTestId("policy-form");
  await form.getByTestId("inherit-suggestedCheckIn").uncheck();
  await form.locator("#pol-suggestedCheckIn").fill("07:45");
  await form.getByTestId("policy-save").click();
  await expect(page.getByText(/Saved as version 1/)).toBeVisible();
  await expect(page.locator("#plant-p4").getByTestId("site-overrides")).toContainText("07:45 AM");
  await page.goto("/admin/attendance?tab=register&project=p4");
  await expect(page.getByTestId("register")).toHaveAttribute("data-suggested-in", "07:45");

  // Put both back (as new versions: history is never edited), so other tests see the original settings.
  await page.goto("/admin/settings?plant=p4");
  await page.getByTestId("policy-form").getByTestId("inherit-suggestedCheckIn").check();
  await page.getByTestId("policy-form").getByTestId("policy-save").click();
  await expect(page.getByText(/Saved as version 2/)).toBeVisible();
  await page.goto("/admin/settings?edit=company");
  await page.locator("#pol-suggestedCheckIn").fill("");
  await page.getByTestId("policy-save").click();
  await expect(page.getByText(/Saved as version 3/)).toBeVisible();
  await expect(page.getByTestId("company-suggestedCheckIn")).toHaveText("None (operators enter the time)");
  await expect(page.getByTestId("settings-history").locator("li")).toHaveCount(8); // 1 company + 3 demo plants + 4 new versions
});

test("operators cannot open attendance settings", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("demo-login-demo-op-pvc").click();
  await page.waitForURL("**/attendance");
  await page.goto("/admin/settings");
  await page.waitForURL("**/attendance");
});

test("payroll shows contractor totals, flags what is missing, and exports", async ({ page }) => {
  await loginAdmin(page);
  await page.goto("/admin/attendance?tab=payroll");
  const table = page.getByTestId("payroll-table");
  await expect(table.getByRole("link", { name: "Shakti Labour Services (Demo)" })).toBeVisible();
  // Pragati's commission basis is not decided in the demo rule: no total is invented.
  await expect(table.getByText(/What commission is calculated on/).first()).toBeVisible();
  await expect(page.getByTestId("payroll-totals").getByText("Needs configuration", { exact: true })).toBeVisible();
  await table.getByRole("link", { name: "Shakti Labour Services (Demo)" }).click();
  await expect(page.getByTestId("payroll-workers")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-payroll").click();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile((await (await downloadPromise).path())!)) as unknown as ArrayBuffer);
  expect(wb.worksheets.map((w) => w.name)).toEqual(["Payroll", "Workers"]);
});

test("WhatsApp is simulated in demo, and admin-only", async ({ page }) => {
  await loginAdmin(page);
  await page.goto("/admin/settings/whatsapp");
  await expect(page.getByTestId("provider-mode")).toHaveText(/Simulated/);
  await page.getByTestId("preview-message").click();
  await expect(page.getByTestId("message-preview")).toContainText("हाज़िरी");
  await expect(page.getByTestId("message-preview")).not.toContainText("₹");
  await expect(page.getByTestId("whatsapp-contacts").getByText("+999").first()).toBeVisible();
  const res = await page.request.post("/api/whatsapp/dispatch");
  expect(res.status()).toBe(503); // no scheduler secret configured in this run
});

test("operators cannot open payroll, imports or WhatsApp", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("demo-login-demo-op-pvc").click();
  await page.waitForURL("**/attendance");
  for (const path of ["/admin/settings/whatsapp", "/admin/workers/import", "/admin/attendance?tab=payroll"]) {
    await page.goto(path);
    await page.waitForURL("**/attendance");
  }
  expect((await page.request.get("/api/export/payroll")).status()).toBe(403);
  expect((await page.request.get("/api/whatsapp/contacts-template")).status()).toBe(403);
});
