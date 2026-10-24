// Scheduled WhatsApp dispatch on AWS: EventBridge Scheduler runs this every 10 minutes.
//
// It holds no state and makes no decisions. It calls the app's
// POST /api/whatsapp/dispatch with the shared CRON_SECRET; the app then queues the
// day's messages once (idempotency keys in the outbound_messages table), re-checks
// consent, the number and the latest attendance values just before each send, and
// records every provider response. Running this twice, late, or after a retry is
// therefore harmless. Live sending stays off until WHATSAPP_LIVE_SENDING=enabled is
// set on the app; until then the app only simulates messages.
//
// Deployed inline by infra/ (Node.js 22 runtime, which includes the AWS SDK v3).
"use strict";

const TIMEOUT_MS = 50_000;

/** Reads the CRON_SECRET value from the app's Secrets Manager secret (JSON). */
async function readCronSecret(secretArn) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- inline Lambda code is CommonJS; the SDK ships with the runtime
  const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretArn }));
  const value = JSON.parse(out.SecretString || "{}").CRON_SECRET;
  if (typeof value !== "string" || value.length < 32) throw new Error("CRON_SECRET is missing from the app secret");
  return value;
}

/** APP_ENDPOINT is the ECS Express endpoint, with or without "https://". Only HTTPS is accepted. */
function dispatchUrl(endpoint) {
  const raw = (endpoint || "").trim().replace(/\/+$/, "");
  const base = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base)) throw new Error("APP_ENDPOINT must be the app's https host");
  return `${base}/api/whatsapp/dispatch`;
}

function makeHandler({ getSecret = readCronSecret, fetchImpl = fetch, env = process.env, log = console } = {}) {
  let secret = null; // cached while the Lambda environment stays warm
  return async function handler() {
    const url = dispatchUrl(env.APP_ENDPOINT);
    if (!env.CRON_SECRET_ARN) throw new Error("CRON_SECRET_ARN is not set");
    if (!secret) secret = await getSecret(env.CRON_SECRET_ARN);

    const res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      result = { body: text.slice(0, 300) };
    }
    // Counts and reasons only; the app never returns phone numbers or message text here.
    log.log(JSON.stringify({ httpStatus: res.status, result }));
    if (res.status === 401) secret = null; // the secret may have been rotated: read it again next time
    // A failure makes EventBridge Scheduler retry; repeating a dispatch is safe.
    if (!res.ok) throw new Error(`Dispatch returned HTTP ${res.status}`);
    return result;
  };
}

exports.makeHandler = makeHandler;
exports.handler = makeHandler();
