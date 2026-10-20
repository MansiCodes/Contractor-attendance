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
  await expect(page.getByTestId("tile-sites")).toContainText("5");
  await expect(page.getByTestId("tile-contractors")).toContainText("4");
  await expect(page.getByText("Sites with incomplete attendance today")).toBeVisible();
  const table = page.getByTestId("contractor-summary");
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByText("Not configured")).toBeVisible();
});

test("admin adds a worker who appears on the site register, then deactivates them", async ({ page }) => {
  await loginAdmin(page);
  await page.goto("/admin/contractors/c2");
  await page.getByTestId("add-worker").click();
  await page.getByLabel("Full name").fill("Playwright Testworker");
  await page.getByLabel("Project site").selectOption({ label: "District Hospital Fire Safety Retrofit (Demo)" });
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
  expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Attendance"]);

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
  wb.getWorksheet("Attendance")!.eachRow((r, i) => {
    if (i > 1 && r.getCell(6).value === "Present") presentRows++;
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
  await expect(page.getByAltText("Brahmaputra Contractors (Demo) photo")).toBeVisible();
  await page.goto("/admin/contractors");
  await expect(page.getByAltText("Brahmaputra Contractors (Demo) photo")).toBeVisible();
});

test("admin adds an operator, grants one site, and the operator sees only that site", async ({ page }) => {
  await loginAdmin(page);
  await page.goto("/admin/projects?tab=operators");
  await page.getByRole("button", { name: "Add operator" }).click();
  await page.getByLabel("Name").fill("Test Site Operator");
  await page.getByLabel("Email").fill("test.operator@demo.invalid");
  await page.getByRole("dialog").getByRole("button", { name: "Add operator" }).click();
  await expect(page.getByText("Operator added")).toBeVisible();
  const card = page.locator("li", { hasText: "test.operator@demo.invalid" });
  await card.getByLabel("Water Treatment Plant Fire Systems (Demo)").check();
  await expect(page.getByText("Access granted")).toBeVisible();

  await page.getByTestId("user-menu").click();
  await page.getByRole("menuitem", { name: "Switch demo user" }).click();
  await page.waitForURL("**/login");
  await page.getByRole("button", { name: /Test Site Operator/ }).click();
  await page.waitForURL("**/attendance");
  // Auto-waiting: the register streams in after its loading skeleton.
  await expect(page.getByTestId("project-select").locator("option")).toHaveText(["Water Treatment Plant Fire Systems (Demo) — Guwahati, Assam"]);
});
