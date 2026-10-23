import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getAppMode } from "@/lib/config";
import type { OutboundMessage } from "@/lib/domain/messaging";

// WhatsApp transports. Credentials are read from server environment variables
// only and never sent to the browser.
//
// LIVE SENDING IS OFF unless ALL of these hold: the app runs in live mode,
// WHATSAPP_LIVE_SENDING=enabled, and the access token and phone number id are set.
// Otherwise every message goes to the mock transport, which sends nothing.

type Env = Record<string, string | undefined>;

export interface ProviderStatus {
  transport: "mock" | "cloud_api";
  liveSendingEnabled: boolean;
  /** which credentials are present (never their values) */
  configured: { accessToken: boolean; phoneNumberId: boolean; appSecret: boolean; verifyToken: boolean; cronSecret: boolean };
  apiVersion: string;
  /** plain-language reason when live sending is off */
  reason: string | null;
}

export function providerStatus(env: Env = process.env): ProviderStatus {
  const configured = {
    accessToken: !!env.WHATSAPP_ACCESS_TOKEN?.trim(),
    phoneNumberId: !!env.WHATSAPP_PHONE_NUMBER_ID?.trim(),
    appSecret: !!env.WHATSAPP_APP_SECRET?.trim(),
    verifyToken: !!env.WHATSAPP_VERIFY_TOKEN?.trim(),
    cronSecret: !!env.CRON_SECRET?.trim(),
  };
  const switchOn = env.WHATSAPP_LIVE_SENDING?.trim() === "enabled";
  let reason: string | null = null;
  if (getAppMode(env) !== "live") reason = "Demo mode: messages are simulated, nothing is sent.";
  else if (!switchOn) reason = "Live sending is switched off (WHATSAPP_LIVE_SENDING is not 'enabled'). Messages are simulated.";
  else if (!configured.accessToken || !configured.phoneNumberId) reason = "WhatsApp Cloud API credentials are missing. Messages are simulated.";
  const live = reason === null;
  return { transport: live ? "cloud_api" : "mock", liveSendingEnabled: live, configured, apiVersion: env.WHATSAPP_API_VERSION?.trim() || "v21.0", reason };
}

export type SendOutcome = { ok: true; providerMessageId: string } | { ok: false; error: string; retryable: boolean };

export interface MessageTransport {
  readonly kind: "mock" | "cloud_api";
  send(message: Pick<OutboundMessage, "to" | "templateName" | "language" | "params">): Promise<SendOutcome>;
}

/**
 * Sends nothing. Succeeds, except for numbers ending in 0000, which simulate an
 * unreachable phone so retries and failures can be tried out in the demo.
 */
export const mockTransport: MessageTransport = {
  kind: "mock",
  async send(message) {
    if (message.to.endsWith("0000")) return { ok: false, error: "Simulated: the phone could not be reached", retryable: true };
    return { ok: true, providerMessageId: `mock-${randomUUID()}` };
  },
};

const LANGUAGE_CODE: Record<OutboundMessage["language"], string> = { hi: "hi", hi_latn: "hi", en: "en" };

/** Meta WhatsApp Cloud API: an approved template message with body parameters. */
export function cloudApiTransport(env: Env = process.env): MessageTransport {
  const token = env.WHATSAPP_ACCESS_TOKEN!.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID!.trim();
  const version = env.WHATSAPP_API_VERSION?.trim() || "v21.0";
  return {
    kind: "cloud_api",
    async send(message) {
      let res: Response;
      try {
        res = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: message.to.replace(/^\+/, ""),
            type: "template",
            template: {
              name: message.templateName,
              language: { code: LANGUAGE_CODE[message.language] },
              components: [{ type: "body", parameters: message.params.map((text) => ({ type: "text", text })) }],
            },
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        // The request may have reached Meta before the connection failed: retrying could
        // deliver twice, so an admin checks first and uses "Retry failed".
        return { ok: false, error: `Delivery uncertain (network error: ${(e as Error).message}). Check with the worker before retrying.`, retryable: false };
      }
      const json = (await res.json().catch(() => null)) as { messages?: { id: string }[]; error?: { message?: string; code?: number } } | null;
      if (res.ok && json?.messages?.[0]?.id) return { ok: true, providerMessageId: json.messages[0].id };
      const error = json?.error?.message ?? `HTTP ${res.status}`;
      // Only "too many requests" is a clear "not sent, try later". A 5xx may or may not have
      // been delivered, and template/number errors will not succeed on retry.
      return { ok: false, error: res.status >= 500 ? `Delivery uncertain (${error}). Check before retrying.` : error, retryable: res.status === 429 };
    },
  };
}

export function getTransport(env: Env = process.env): MessageTransport {
  return providerStatus(env).liveSendingEnabled ? cloudApiTransport(env) : mockTransport;
}

/** Verifies Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export function verifyWebhookSignature(rawBody: string, header: string | null, appSecret: string | undefined): boolean {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface ProviderStatusUpdate {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  at: string | null;
  error: string | null;
}

/** Status updates in a Cloud API webhook payload (other events are ignored). */
export function parseStatusUpdates(payload: unknown): ProviderStatusUpdate[] {
  const out: ProviderStatusUpdate[] = [];
  const entries = (payload as { entry?: { changes?: { value?: { statuses?: unknown[] } }[] }[] })?.entry ?? [];
  for (const e of entries) {
    for (const c of e.changes ?? []) {
      for (const raw of c.value?.statuses ?? []) {
        const s = raw as { id?: string; status?: string; timestamp?: string; errors?: { title?: string; message?: string }[] };
        if (!s.id || !["sent", "delivered", "read", "failed"].includes(s.status ?? "")) continue;
        out.push({
          providerMessageId: s.id,
          status: s.status as ProviderStatusUpdate["status"],
          at: s.timestamp && /^\d+$/.test(s.timestamp) ? new Date(Number(s.timestamp) * 1000).toISOString() : null,
          error: s.errors?.[0] ? s.errors[0].message ?? s.errors[0].title ?? "Failed" : null,
        });
      }
    }
  }
  return out;
}
