import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { toActionError } from "@/lib/server/actions/run";
import { messagingOverview } from "@/lib/server/services/messaging";
import { getContext } from "@/lib/server/session";

// Template for adding WhatsApp numbers and consent in bulk: one row per active
// worker, with the current values filled in. Admin only.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await getContext();
    const overview = await messagingOverview(ctx); // admin-only, enforced in the service
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("WhatsApp contacts", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = [
      { header: "Contractor", key: "contractor", width: 28 },
      { header: "Employee ID", key: "emp", width: 14 },
      { header: "Worker name", key: "name", width: 26 },
      { header: "Country code", key: "cc", width: 10 },
      { header: "WhatsApp number", key: "number", width: 16 },
      { header: "WhatsApp messages (Yes/No)", key: "enabled", width: 14 },
      { header: "Consent (Granted/Withdrawn/Unknown)", key: "consent", width: 18 },
      { header: "Consent source", key: "source", width: 30 },
      { header: "Language (hi / hi_latn / en)", key: "lang", width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getColumn("emp").numFmt = "@";
    ws.getColumn("number").numFmt = "@";
    for (const r of overview.contacts) {
      ws.addRow({
        contractor: r.contractorName,
        emp: r.employeeCode,
        name: r.workerName,
        cc: r.contact?.countryCode ?? "+91",
        number: r.contact?.whatsappNumber ?? "",
        enabled: r.contact?.enabled ? "Yes" : "No",
        consent: r.contact ? r.contact.consentStatus[0].toUpperCase() + r.contact.consentStatus.slice(1) : "Unknown",
        source: r.contact?.consentSource ?? "",
        lang: r.contact?.preferredLanguage ?? "",
      });
    }
    const buf = await wb.xlsx.writeBuffer();
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="whatsapp_contacts_template.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const err = toActionError(e);
    const status = err.code === "unauthenticated" ? 401 : err.code === "forbidden" ? 403 : 500;
    return NextResponse.json({ error: err.error }, { status });
  }
}
