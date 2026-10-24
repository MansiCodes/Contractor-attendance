# WhatsApp attendance messages

**Live sending is off.** In this build every message goes to a mock transport that sends nothing. The demo uses fictional `+999` numbers (not a real country code). Nothing here has been connected to Meta.

## What a worker receives

One short message per confirmed working day: date, plant, shift, IN time, OUT time (marked "next day" for night shifts), and total time. It never mentions wages or amounts. Hindi (Devanagari) is the default. The other options are Hindi in English letters, English only, or Hindi with English underneath. Admins can preview every variant under **Settings → WhatsApp**.

A message is sent only when **all** of these hold:

| Check | Where it is enforced |
| --- | --- |
| Valid number (India: 10-digit mobile starting 6–9) | `checkNumber()` in `src/lib/domain/messaging.ts` |
| Messages switched on for that worker | `worker_contacts.enabled` |
| Consent given, with when and how (withdrawal stops messages at once; every change is kept) | `consent_status`, `worker_consent_events` |
| Attendance confirmed as present, with a confirmed OUT (complete duration) | `eligibility()` |
| Work date on or after the messaging start date (no retroactive messages, e.g. for imported September records) | `messaging_settings.start_date` (cannot be moved back) |
| No message yet for that record | unique `outbound_messages.idempotency_key` (`att:<attendance id>`) |

Absences never get a message. If a day changes after its message was sent, a **separate correction notice** is queued once per new version (`cor:<id>:v<version>`). The old values stay in the attendance audit log. Correction notices can be turned off.

## How sending works

```
attendance saved ──► (scheduled run after the send time, or "Send now")
                     queueEligible(): one queued message per eligible record (idempotent)
                     processQueue(): claim → send through the transport → sent / retry / failed
provider webhook ──► delivery statuses (sent → delivered → read, or failed), forward only
```

- **Checked again before sending**: a queued message is re-checked against consent, number, the worker's messages switch, the attendance record and the start date when its turn comes. Its text is rebuilt from the record as it is then. If it is no longer allowed, it is cancelled.
- **Retries** happen only when the provider clearly did not take the message ("too many requests", or the demo's unreachable number): after 1, 5, 30 and 120 minutes, then failed. A network error or a provider server error may mean the message was delivered, so it is marked failed with "delivery uncertain" for an admin to check. The same applies to a message left "sending" for over 10 minutes. These are never re-sent automatically.
- **Delivery statuses** only move forward. A failure reported after "sent" is final. A status that arrives before the send result is saved is logged and applied once the message is saved.
- **Pause all** stops queuing and sending. Queued messages wait.
- **Retry failed** puts failed messages back in the queue.
- **Test message** goes only to the saved test number.
- History shows numbers masked except the last 4 digits.

## The scheduler (does not depend on a dev server or a browser)

`GET` or `POST /api/whatsapp/dispatch` with `Authorization: Bearer <CRON_SECRET>`. Call it every 10–15 minutes. It queues the day's messages once after the configured send time (head-office timezone), and sends due retries on every call. Without `CRON_SECRET` it answers 503.

On AWS this is **EventBridge Scheduler → Lambda** (`infra/lambda/dispatch.cjs`, defined in the `NfAttendance-App` stack). The Lambda only calls this endpoint with the secret; the queue, consent checks, retries and status ledger stay in the app and the database. The schedule is created **DISABLED** and is switched on only as part of the go-live below (stack parameter `WhatsAppScheduleState=ENABLED`). Any other cron that sends the bearer header works too.

## Environment variables (server only, never `NEXT_PUBLIC_`)

On AWS the keys and `CRON_SECRET` live in the Secrets Manager secret `nf-attendance/app` and `WHATSAPP_LIVE_SENDING` is a stack parameter (see [aws/deployment.md](aws/deployment.md) §9 and §12). For other setups, `.env.example` was not changed; the variables are:

```
# WhatsApp (Meta Cloud API). Live sending also needs WHATSAPP_LIVE_SENDING=enabled.
WHATSAPP_LIVE_SENDING=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_API_VERSION=v21.0
# Protects /api/whatsapp/dispatch
CRON_SECRET=
```

Live sending happens only when the app is in production mode (`APP_MODE=production`), `WHATSAPP_LIVE_SENDING=enabled`, and the token and phone number ID are set. The admin screen shows which values are present, never the values.

## Going live: checklist

1. Meta Business verification, a WhatsApp Business phone number, and a permanent (system user) access token.
2. Create and get approval for two **utility** templates in WhatsApp Manager, with seven body parameters in this order: name, date, plant, shift, IN, OUT, total time. The text to submit is in `TEMPLATES` in `src/lib/domain/messaging.ts`. Enter the approved names under Settings → WhatsApp.
3. Webhook: set the callback URL `https://<AppUrl>/api/whatsapp/webhook`, with the verify token `WHATSAPP_VERIFY_TOKEN`, and subscribe to `messages`. Every POST is checked against `X-Hub-Signature-256` using `WHATSAPP_APP_SECRET`.
4. Collect consent (form or recorded verbal) and numbers through the contacts template. Numbers are never generated.
5. Put the keys in the `nf-attendance/app` secret and redeploy the App stack with live sending and the schedule enabled ([aws/deployment.md](aws/deployment.md) §12). The WhatsApp tables come with the normal migrations.
6. Send a test message to your own number, then turn messaging on with a start date of today.

Not done or not verified: no message has been sent through Meta, and the webhook has not received a real Meta payload (the signature check and status parsing are unit-tested). The PostgreSQL store's messaging methods are tested against the real migrations in PGlite (`tests/db`), not yet against Amazon RDS.
