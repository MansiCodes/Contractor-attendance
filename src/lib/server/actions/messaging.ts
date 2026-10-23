"use server";

import * as messaging from "../services/messaging";
import { runAction } from "./run";

async function uploaded(formData: FormData) {
  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("No file provided");
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

export async function saveMessagingSettingsAction(input: unknown) {
  return runAction((ctx) => messaging.saveMessagingSettings(ctx, input).then(() => null));
}
export async function setMessagingPausedAction(paused: boolean) {
  return runAction((ctx) => messaging.setPaused(ctx, paused).then(() => null));
}
export async function saveWorkerContactAction(workerId: string, input: unknown) {
  return runAction((ctx) => messaging.saveWorkerContact(ctx, workerId, input).then(() => null));
}
export async function consentHistoryAction(workerId: string) {
  return runAction((ctx) => messaging.consentHistory(ctx, workerId), { revalidate: false });
}
export async function previewMessageAction(input: unknown) {
  return runAction((ctx) => messaging.previewMessage(ctx, input), { revalidate: false });
}
export async function sendNowAction() {
  return runAction((ctx) => messaging.sendNow(ctx));
}
export async function sendTestMessageAction(input: unknown) {
  return runAction((ctx) => messaging.sendTestMessage(ctx, input));
}
export async function retryFailedAction() {
  return runAction((ctx) => messaging.retryFailed(ctx));
}
export async function previewContactsImportAction(formData: FormData) {
  return runAction(async (ctx) => messaging.previewContactsImport(ctx, await uploaded(formData)), { revalidate: false });
}
export async function applyContactsImportAction(formData: FormData) {
  return runAction(async (ctx) => messaging.applyContactsImport(ctx, await uploaded(formData)));
}
