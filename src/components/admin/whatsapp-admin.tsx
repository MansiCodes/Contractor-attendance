"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, Eye, Loader2, Pause, Pencil, Play, RotateCcw, Search, Send, ShieldCheck, Upload } from "lucide-react";
import { StatusPill, type Tone } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { INELIGIBLE_TEXT, type ConsentStatus, type Ineligible, type MessageLanguage, type MessageStatus, type MessagingSettings, type WorkerContact } from "@/lib/domain/messaging";
import {
  applyContactsImportAction,
  previewContactsImportAction,
  previewMessageAction,
  retryFailedAction,
  saveMessagingSettingsAction,
  saveWorkerContactAction,
  sendNowAction,
  sendTestMessageAction,
  setMessagingPausedAction,
} from "@/lib/server/actions/messaging";
import type { ContactImportRow, ContactRow, MessageHistoryRow } from "@/lib/server/services/messaging";
import type { ProviderStatus } from "@/lib/server/messaging/transport";
import { cn } from "@/lib/utils";
import { Field, selectClass, ToggleRow, useServerAction } from "./form-bits";

const LANG_LABEL: Record<MessageLanguage, string> = { hi: "Hindi (हिंदी)", hi_latn: "Hindi in English letters", en: "English" };
const STATUS_TONE: Record<MessageStatus, Tone> = { queued: "pending", sending: "pending", sent: "primary", delivered: "present", read: "present", failed: "absent", cancelled: "neutral" };
const STATUS_LABEL: Record<MessageStatus, string> = { queued: "Queued", sending: "Sending", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed", cancelled: "Cancelled" };
const CONSENT_TONE: Record<ConsentStatus, Tone> = { granted: "present", withdrawn: "absent", unknown: "neutral" };
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");

export interface WhatsAppAdminProps {
  settings: MessagingSettings;
  provider: ProviderStatus;
  counts: Record<MessageStatus, number>;
  pending: number;
  history: MessageHistoryRow[];
  contacts: ContactRow[];
  consent: { granted: number; withdrawn: number; ready: number };
  demo: boolean;
  statusFilter: string | null;
}

export function WhatsAppAdmin(p: WhatsAppAdminProps) {
  return (
    <div className="space-y-8">
      <ProviderCard {...p} />
      <SettingsForm settings={p.settings} demo={p.demo} />
      <Contacts contacts={p.contacts} consent={p.consent} demo={p.demo} />
      <History history={p.history} statusFilter={p.statusFilter} counts={p.counts} />
    </div>
  );
}

// ---------- provider, counts and actions ----------

function ProviderCard({ provider, counts, pending, settings, demo }: WhatsAppAdminProps) {
  const { pending: busy, run } = useServerAction();
  const [lang, setLang] = useState<MessageLanguage>(settings.defaultLanguage);
  return (
    <section className="space-y-3" data-testid="whatsapp-status">
      <div className={cn("flex flex-wrap items-start gap-3 rounded-xl p-4 text-sm", provider.liveSendingEnabled ? "bg-present-soft" : "bg-pending-soft")}>
        <ShieldCheck className={cn("mt-0.5 size-5 shrink-0", provider.liveSendingEnabled ? "text-present" : "text-pending")} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold" data-testid="provider-mode">
            {provider.liveSendingEnabled ? "Live: messages are sent through the WhatsApp Cloud API" : "Simulated: no WhatsApp message leaves this app"}
          </p>
          {provider.reason && <p className="mt-0.5">{provider.reason}</p>}
          <p className="mt-1 text-xs text-muted-foreground">
            Server configuration: access token {provider.configured.accessToken ? "set" : "missing"} · phone number ID {provider.configured.phoneNumberId ? "set" : "missing"} · app secret{" "}
            {provider.configured.appSecret ? "set" : "missing"} · webhook verify token {provider.configured.verifyToken ? "set" : "missing"} · scheduler secret{" "}
            {provider.configured.cronSecret ? "set" : "missing"}. Values are never shown here.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-xl bg-card shadow-surface sm:grid-cols-4 sm:divide-y-0">
        {(
          [
            ["Pending", pending],
            ["Sent", counts.sent + counts.delivered + counts.read],
            ["Delivered / read", counts.delivered + counts.read],
            ["Failed", counts.failed],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="px-4 py-3">
            <div className="text-xs font-medium text-muted-foreground">{k}</div>
            <div className={cn("tabular mt-1 text-xl font-semibold", k === "Failed" && v > 0 && "text-absent")}>{v}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !settings.enabled || settings.paused}
          onClick={() =>
            run(() => sendNowAction(), {
              success: (r) => {
                const skipped = Object.entries(r.queue?.skipped ?? {})
                  .filter(([k]) => k !== "already_sent" && k !== "not_present")
                  .map(([k, n]) => `${n} · ${INELIGIBLE_TEXT[k as Ineligible].toLowerCase()}`);
                return `Queued ${r.queue?.queued ?? 0} message(s), ${r.queue?.corrections ?? 0} correction(s). Sent ${r.send?.sent ?? 0}${r.send?.retrying ? `, ${r.send.retrying} will retry` : ""}${r.send?.failed ? `, ${r.send.failed} failed` : ""}.${skipped.length ? ` Not sent: ${skipped.join("; ")}.` : ""}`;
              },
            })
          }
          data-testid="send-now"
        >
          {busy ? <Loader2 className="animate-spin" /> : <Send />} Send now
        </Button>
        <Button variant="outline" disabled={busy || counts.failed === 0} onClick={() => run(() => retryFailedAction(), { success: (n) => `${n} message(s) queued again` })} data-testid="retry-failed">
          <RotateCcw /> Retry failed
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => run(() => setMessagingPausedAction(!settings.paused), { success: settings.paused ? "Messaging resumed" : "All messaging paused" })}
          data-testid="pause-all"
        >
          {settings.paused ? <Play /> : <Pause />} {settings.paused ? "Resume" : "Pause all"}
        </Button>
        <div className="flex items-center gap-2 sm:ml-auto">
          <select aria-label="Test message language" className={cn(selectClass, "h-10 w-auto text-sm")} value={lang} onChange={(e) => setLang(e.target.value as MessageLanguage)}>
            {(Object.keys(LANG_LABEL) as MessageLanguage[]).map((l) => (
              <option key={l} value={l}>
                {LANG_LABEL[l]}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            disabled={busy || !settings.testNumber}
            onClick={() =>
              run(() => sendTestMessageAction({ language: lang }), {
                success: (r) => (r.ok ? `Test message ${r.transport === "mock" ? "simulated" : "sent"}` : `Test message failed: ${r.error}`),
              })
            }
            data-testid="send-test"
          >
            <Send /> Test message
          </Button>
        </div>
      </div>
      {!settings.enabled && <p className="text-sm text-muted-foreground">Turn WhatsApp messages on below to use “Send now” and the daily schedule.</p>}
      {demo && <p className="text-xs text-muted-foreground">Demo numbers use the fictional +999 code. A number ending in 0000 simulates an unreachable phone.</p>}
    </section>
  );
}

// ---------- settings ----------

function SettingsForm({ settings, demo }: { settings: MessagingSettings; demo: boolean }) {
  const { pending, run } = useServerAction();
  const [v, setV] = useState({ ...settings, testNumber: settings.testNumber ?? "" });
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, startPreview] = useTransition();
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) => setV((s) => ({ ...s, [k]: value }));
  const save = () =>
    run(
      () =>
        saveMessagingSettingsAction({
          enabled: v.enabled, paused: v.paused, sendTime: v.sendTime, defaultLanguage: v.defaultLanguage, includeEnglish: v.includeEnglish,
          attendanceTemplate: v.attendanceTemplate, correctionTemplate: v.correctionTemplate, correctionNotices: v.correctionNotices, startDate: v.startDate,
          testNumber: v.testNumber,
        }),
      { success: "WhatsApp settings saved" },
    );
  const showPreview = (kind: "attendance" | "correction") =>
    startPreview(async () => {
      const res = await previewMessageAction({ language: v.defaultLanguage, includeEnglish: v.includeEnglish, kind });
      if (res.ok) setPreview(res.data.body);
      else toast.error(res.error);
    });
  return (
    <section className="space-y-3" data-testid="whatsapp-settings">
      <h2 className="text-base font-semibold">Settings</h2>
      <div className="space-y-4 rounded-xl bg-card p-4 shadow-surface">
        <ToggleRow
          label="Send WhatsApp attendance messages"
          description="Each worker with consent gets one message per confirmed day, after the OUT time is recorded. No wages are included. Absences never get a message."
          checked={v.enabled}
          onCheckedChange={(x) => set("enabled", x)}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Daily send time" htmlFor="wa-time" hint="Head-office time. Covers the last 3 days' confirmed checkouts.">
            <Input id="wa-time" type="time" value={v.sendTime} onChange={(e) => set("sendTime", e.target.value)} />
          </Field>
          <Field label="Default language" htmlFor="wa-lang" hint="A worker's own language setting wins.">
            <select id="wa-lang" className={selectClass} value={v.defaultLanguage} onChange={(e) => set("defaultLanguage", e.target.value as MessageLanguage)}>
              {(Object.keys(LANG_LABEL) as MessageLanguage[]).map((l) => (
                <option key={l} value={l}>
                  {LANG_LABEL[l]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Messages start from" htmlFor="wa-start" hint="Older attendance (including imported records) never gets messages.">
            <Input id="wa-start" type="date" value={v.startDate} onChange={(e) => set("startDate", e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Attendance template name" htmlFor="wa-tpl" hint="As approved in WhatsApp Manager.">
            <Input id="wa-tpl" value={v.attendanceTemplate} onChange={(e) => set("attendanceTemplate", e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Correction template name" htmlFor="wa-tplc">
            <Input id="wa-tplc" value={v.correctionTemplate} onChange={(e) => set("correctionTemplate", e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Test number" htmlFor="wa-test" hint={demo ? "Demo: use +999 followed by 6–10 digits." : "With country code, e.g. +91…"}>
            <Input id="wa-test" value={v.testNumber} onChange={(e) => set("testNumber", e.target.value)} inputMode="tel" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4.5 accent-primary" checked={v.includeEnglish} onChange={(e) => set("includeEnglish", e.target.checked)} />
          Add the English text below the Hindi text
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4.5 accent-primary" checked={v.correctionNotices} onChange={(e) => set("correctionNotices", e.target.checked)} />
          Send a separate correction notice when a day is changed after its message was sent
        </label>
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={pending} data-testid="save-whatsapp-settings">
            {pending && <Loader2 className="animate-spin" />} Save settings
          </Button>
          <Button variant="outline" onClick={() => showPreview("attendance")} disabled={previewing} data-testid="preview-message">
            <Eye /> Preview message
          </Button>
          <Button variant="ghost" onClick={() => showPreview("correction")} disabled={previewing}>
            Preview correction
          </Button>
        </div>
        {preview && (
          <pre className="max-w-md rounded-xl bg-[#e7ffdb] p-3 font-sans text-sm leading-6 whitespace-pre-wrap text-[#111b21] shadow-sm" data-testid="message-preview">
            {preview}
          </pre>
        )}
      </div>
    </section>
  );
}

// ---------- contacts ----------

function Contacts({ contacts, consent, demo }: { contacts: ContactRow[]; consent: { granted: number; withdrawn: number; ready: number }; demo: boolean }) {
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<"all" | "ready" | "missing">("all");
  const [editing, setEditing] = useState<ContactRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts.filter((c) => {
      const ready = !!c.contact?.enabled && c.contact.consentStatus === "granted" && c.numberValid;
      if (only === "ready" && !ready) return false;
      if (only === "missing" && ready) return false;
      return !q || c.workerName.toLowerCase().includes(q) || (c.employeeCode ?? "").toLowerCase().includes(q) || c.contractorName.toLowerCase().includes(q);
    });
  }, [contacts, query, only]);
  return (
    <section className="space-y-3" data-testid="whatsapp-contacts">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Worker numbers and consent</h2>
          <p className="text-sm text-muted-foreground">
            {consent.ready} ready to receive messages · {consent.granted} consented · {consent.withdrawn} withdrawn. Numbers are never invented: add them from the worker or the
            template.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/api/whatsapp/contacts-template" className="inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium hover:bg-muted" data-testid="contacts-template">
            <Download className="size-4" /> Template
          </a>
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <Upload /> Import numbers
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, employee ID or contractor"
            aria-label="Search workers"
            className="h-10 w-full rounded-lg border border-input bg-card pr-3 pl-9 text-sm outline-none focus-visible:border-primary"
          />
        </div>
        <select aria-label="Show" className={cn(selectClass, "h-10 text-sm sm:w-56")} value={only} onChange={(e) => setOnly(e.target.value as typeof only)}>
          <option value="all">All active workers</option>
          <option value="ready">Ready to receive</option>
          <option value="missing">Not ready</option>
        </select>
      </div>
      <div className="max-h-[32rem] overflow-auto rounded-xl bg-card shadow-surface">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="sticky top-0 bg-card text-left text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
            <tr className="border-b">
              <th className="px-3 py-2.5">Worker</th>
              <th className="px-3 py-2.5">Contractor</th>
              <th className="px-3 py-2.5">WhatsApp</th>
              <th className="px-3 py-2.5">Consent</th>
              <th className="px-3 py-2.5">Language</th>
              <th className="w-10 px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {visible.slice(0, 400).map((c) => (
              <tr key={c.workerId}>
                <td className="px-3 py-2">
                  <div className="font-medium">{c.workerName}</div>
                  <div className="font-mono text-xs whitespace-pre text-muted-foreground">{c.employeeCode ?? c.workerCode}</div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{c.contractorName}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {c.contact?.whatsappNumber ? (
                    <>
                      <span className={cn(!c.numberValid && "text-absent")}>
                        {c.contact.countryCode} {c.contact.whatsappNumber}
                      </span>
                      <div className="text-xs text-muted-foreground">{c.contact.enabled ? "Messages on" : "Messages off"}</div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">No number</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <StatusPill tone={CONSENT_TONE[c.contact?.consentStatus ?? "unknown"]}>{c.contact?.consentStatus === "granted" ? "Given" : c.contact?.consentStatus === "withdrawn" ? "Withdrawn" : "Not recorded"}</StatusPill>
                  {c.contact?.consentAt && <div className="text-xs text-muted-foreground">{fmt(c.contact.consentAt)}</div>}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{c.contact?.preferredLanguage ? LANG_LABEL[c.contact.preferredLanguage] : "Default"}</td>
                <td className="px-2 py-2">
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit WhatsApp for ${c.workerName}`} onClick={() => setEditing(c)}>
                    <Pencil />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length > 400 && <p className="px-3 py-2 text-xs text-muted-foreground">Showing 400 of {visible.length}. Search to narrow the list.</p>}
      </div>
      {editing && <ContactDialog row={editing} demo={demo} onClose={() => setEditing(null)} />}
      {importOpen && <ContactsImportDialog onClose={() => setImportOpen(false)} />}
    </section>
  );
}

function ContactDialog({ row, demo, onClose }: { row: ContactRow; demo: boolean; onClose: () => void }) {
  const { pending, run } = useServerAction();
  const c: WorkerContact | null = row.contact;
  const [cc, setCc] = useState(c?.countryCode ?? "+91");
  const [num, setNum] = useState(c?.whatsappNumber ?? "");
  const [enabled, setEnabled] = useState(c?.enabled ?? false);
  const [consent, setConsent] = useState<ConsentStatus>(c?.consentStatus ?? "unknown");
  const [source, setSource] = useState(c?.consentSource ?? "");
  const [lang, setLang] = useState<string>(c?.preferredLanguage ?? "");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>WhatsApp · {row.workerName}</DialogTitle>
          <DialogDescription>Record consent only as the worker gave it. Withdrawing consent stops all messages at once; the change is kept in the consent history.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-[6rem_1fr] gap-3">
            <Field label="Code" htmlFor="ct-cc">
              <Input id="ct-cc" value={cc} onChange={(e) => setCc(e.target.value)} />
            </Field>
            <Field label="WhatsApp number" htmlFor="ct-num" hint={demo ? "Demo: +999 numbers only" : "10-digit mobile number"}>
              <Input id="ct-num" value={num} onChange={(e) => setNum(e.target.value)} inputMode="tel" />
            </Field>
          </div>
          <Field label="Consent" htmlFor="ct-consent">
            <select id="ct-consent" className={selectClass} value={consent} onChange={(e) => setConsent(e.target.value as ConsentStatus)}>
              <option value="unknown">Not recorded</option>
              <option value="granted">Given</option>
              <option value="withdrawn">Withdrawn</option>
            </select>
          </Field>
          {consent !== "unknown" && (
            <Field label={consent === "granted" ? "How consent was given" : "How consent was withdrawn"} htmlFor="ct-src" hint="e.g. signed form at the gate, verbal to the supervisor on 24 Oct">
              <Input id="ct-src" value={source} onChange={(e) => setSource(e.target.value)} />
            </Field>
          )}
          <Field label="Language" htmlFor="ct-lang">
            <select id="ct-lang" className={selectClass} value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="">Default</option>
              {(Object.keys(LANG_LABEL) as MessageLanguage[]).map((l) => (
                <option key={l} value={l}>
                  {LANG_LABEL[l]}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4.5 accent-primary" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Send WhatsApp attendance messages to this worker
          </label>
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  saveWorkerContactAction(row.workerId, {
                    countryCode: cc, whatsappNumber: num, enabled, consentStatus: consent, consentSource: source, preferredLanguage: lang || null,
                  }),
                { success: "Saved", onSuccess: onClose },
              )
            }
            data-testid="save-contact"
          >
            {pending && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ContactsImportDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ContactImportRow[] | null>(null);
  const [busy, start] = useTransition();
  const form = () => {
    const fd = new FormData();
    fd.set("file", file!);
    return fd;
  };
  const preview = () =>
    start(async () => {
      const res = await previewContactsImportAction(form());
      if (res.ok) setRows(res.data);
      else toast.error(res.error);
    });
  const apply = () =>
    start(async () => {
      const res = await applyContactsImportAction(form());
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Saved ${res.data.saved} worker(s)${res.data.skipped ? `, ${res.data.skipped} row(s) skipped` : ""}`);
      router.refresh();
      onClose();
    });
  const good = rows?.filter((r) => r.fields).length ?? 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import WhatsApp numbers and consent</DialogTitle>
          <DialogDescription>
            Download the template, fill in numbers and consent, and upload it. Rows are matched by contractor and employee ID. Nothing is saved until you confirm.
          </DialogDescription>
        </DialogHeader>
        <input ref={input} type="file" accept=".xlsx" className="sr-only" onChange={(e) => (setFile(e.target.files?.[0] ?? null), setRows(null))} />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => input.current?.click()}>
            <Upload /> {file ? file.name : "Choose file"}
          </Button>
          <Button disabled={!file || busy} onClick={preview}>
            {busy && !rows ? <Loader2 className="animate-spin" /> : null} Preview
          </Button>
        </div>
        {rows && (
          <ul className="max-h-80 divide-y overflow-auto rounded-lg border text-sm">
            {rows.map((r) => (
              <li key={r.row} className="flex gap-2 px-3 py-2">
                <span className="tabular w-12 shrink-0 text-muted-foreground">Row {r.row}</span>
                <span className="min-w-0 flex-1">
                  {r.workerName ?? r.employeeCode ?? "—"} {r.employeeCode && <span className="font-mono text-xs text-muted-foreground">{r.employeeCode}</span>}
                  {r.error ? <span className="block text-absent">{r.error}</span> : <span className="block text-muted-foreground">{r.fields?.whatsappNumber ? `${r.fields.countryCode} ${r.fields.whatsappNumber}` : "No number"} · consent {r.fields?.consentStatus}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button disabled={!rows || good === 0 || busy} onClick={apply}>
            Save {good} worker(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- history ----------

function History({ history, statusFilter, counts }: { history: MessageHistoryRow[]; statusFilter: string | null; counts: Record<MessageStatus, number> }) {
  const [open, setOpen] = useState<MessageHistoryRow | null>(null);
  const filters: (MessageStatus | null)[] = [null, "queued", "sent", "delivered", "read", "failed"];
  return (
    <section className="space-y-3" data-testid="whatsapp-history">
      <h2 className="text-base font-semibold">Message history</h2>
      <div className="flex flex-wrap gap-1.5">
        {filters.map((f) => (
          <Link
            key={f ?? "all"}
            href={`/admin/settings/whatsapp${f ? `?status=${f}` : ""}#history`}
            className={cn(
              "flex h-8 items-center rounded-full px-3 text-sm font-medium",
              (statusFilter ?? null) === f ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {f ? `${STATUS_LABEL[f]} (${counts[f]})` : "All"}
          </Link>
        ))}
      </div>
      <div id="history" className="overflow-x-auto rounded-xl bg-card shadow-surface">
        <table className="w-full min-w-[46rem] text-sm">
          <thead className="text-left text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
            <tr className="border-b">
              <th className="px-3 py-2.5">Worker</th>
              <th className="px-3 py-2.5">Contractor</th>
              <th className="px-3 py-2.5">Plant</th>
              <th className="px-3 py-2.5">Date</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Sent at</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {history.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  No messages yet.
                </td>
              </tr>
            )}
            {history.map((m) => (
              <tr key={m.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpen(m)}>
                <td className="px-3 py-2">
                  <div className="font-medium">
                    {m.workerName}
                    {m.kind === "correction" && <span className="ml-1.5 text-xs font-normal text-pending">correction</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {m.employeeCode && <span className="font-mono">{m.employeeCode} · </span>}
                    {m.to}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{m.contractorName}</td>
                <td className="px-3 py-2 text-muted-foreground">{m.plantName}</td>
                <td className="tabular px-3 py-2 whitespace-nowrap">{m.workDate ?? "—"}</td>
                <td className="px-3 py-2">
                  <StatusPill tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</StatusPill>
                  {m.transport === "mock" && <div className="text-xs text-muted-foreground">simulated</div>}
                  {m.lastError && <div className="max-w-56 truncate text-xs text-absent" title={m.lastError}>{m.lastError}</div>}
                </td>
                <td className="tabular px-3 py-2 whitespace-nowrap text-muted-foreground">{fmt(m.sentAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{open.workerName}</DialogTitle>
              <DialogDescription>
                {STATUS_LABEL[open.status]} · {open.attempts} attempt(s) · queued {fmt(open.createdAt)}
                {open.sentAt && ` · sent ${fmt(open.sentAt)}`}
              </DialogDescription>
            </DialogHeader>
            <pre className="rounded-xl bg-[#e7ffdb] p-3 font-sans text-sm leading-6 whitespace-pre-wrap text-[#111b21]">{open.body}</pre>
            {open.lastError && <p className="text-sm text-absent">{open.lastError}</p>}
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
