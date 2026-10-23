"use server";

import * as masterImport from "../services/master-import";
import { runAction } from "./run";

async function uploaded(formData: FormData): Promise<masterImport.UploadedFile> {
  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("No file provided");
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

function options(formData: FormData): unknown {
  const raw = formData.get("options");
  return typeof raw === "string" && raw ? JSON.parse(raw) : {};
}

/** Read-only: parses the workbook and plans the import against the current data. */
export async function previewMasterImportAction(formData: FormData) {
  return runAction(async (ctx) => masterImport.previewMasterImport(ctx, await uploaded(formData), options(formData)), { revalidate: false });
}

export async function applyMasterImportAction(formData: FormData) {
  return runAction(async (ctx) => masterImport.applyMasterImport(ctx, await uploaded(formData), options(formData)));
}

export async function assignWorkersAction(input: unknown) {
  return runAction((ctx) => masterImport.assignUnassignedWorkers(ctx, input));
}

export async function setContractorIdentityAction(contractorId: string, input: unknown) {
  return runAction((ctx) => masterImport.setContractorIdentity(ctx, contractorId, input).then(() => null));
}
