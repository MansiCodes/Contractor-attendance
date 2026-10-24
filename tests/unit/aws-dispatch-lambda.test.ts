import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

// The EventBridge Scheduler Lambda (infra/lambda/dispatch.cjs): a stateless trigger
// for the app's dispatch endpoint. Tested here without AWS.

const require = createRequire(import.meta.url);
const { makeHandler } = require("../../infra/lambda/dispatch.cjs") as {
  makeHandler: (deps: {
    getSecret: (arn: string) => Promise<string>;
    fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
    env: Record<string, string | undefined>;
    log: { log: (s: string) => void };
  }) => () => Promise<unknown>;
};

const HOST = "nf-attendance.ecs.ap-south-1.on.aws";
const URL_OK = `https://${HOST}/api/whatsapp/dispatch`;
const ARN = "arn:aws:secretsmanager:ap-south-1:111111111111:secret:nf-attendance/app";
const SECRET = "s".repeat(48);

function setup(responses: { status: number; body: unknown }[], env: Record<string, string | undefined> = { APP_ENDPOINT: HOST, CRON_SECRET_ARN: ARN }) {
  const getSecret = vi.fn(async () => SECRET);
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  const logs: string[] = [];
  const handler = makeHandler({ getSecret, fetchImpl, env, log: { log: (s) => logs.push(s) } });
  return { handler, getSecret, fetchImpl, calls, logs };
}

describe("scheduled dispatch Lambda", () => {
  it("POSTs to the app with the bearer secret and returns the app's counts", async () => {
    const result = { ran: true, reason: null, queue: { queued: 3, corrections: 0, skipped: {} }, send: { sent: 3, failed: 0, retrying: 0, cancelled: 0 } };
    const { handler, calls, logs } = setup([{ status: 200, body: result }]);
    await expect(handler()).resolves.toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_OK);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    expect(logs[0]).toContain('"httpStatus":200');
    expect(logs.join("")).not.toContain(SECRET);
  });

  it("reads the secret once while warm, and again after a 401 (rotation)", async () => {
    const { handler, getSecret } = setup([
      { status: 200, body: {} },
      { status: 401, body: { error: "Unauthorised" } },
      { status: 200, body: {} },
    ]);
    await handler();
    await expect(handler()).rejects.toThrow("HTTP 401");
    await handler();
    expect(getSecret).toHaveBeenCalledTimes(2);
  });

  it("fails on a server error so the scheduler retries (dispatch is idempotent)", async () => {
    const { handler } = setup([{ status: 500, body: { error: "Dispatch failed" } }]);
    await expect(handler()).rejects.toThrow("HTTP 500");
  });

  it("accepts the endpoint with or without https:// and a trailing slash", async () => {
    for (const APP_ENDPOINT of [HOST, `https://${HOST}`, `https://${HOST}/`]) {
      const { handler, calls } = setup([{ status: 200, body: {} }], { APP_ENDPOINT, CRON_SECRET_ARN: ARN });
      await handler();
      expect(calls[0].url).toBe(URL_OK);
    }
  });

  it("refuses plain HTTP, a path or a missing endpoint before reading any secret", async () => {
    for (const APP_ENDPOINT of ["http://nf.example", "https://nf.example/other", "", undefined]) {
      const { handler, getSecret, fetchImpl } = setup([], { APP_ENDPOINT, CRON_SECRET_ARN: ARN });
      await expect(handler()).rejects.toThrow("APP_ENDPOINT");
      expect(getSecret).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});
