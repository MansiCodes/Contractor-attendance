"use server";

import * as admin from "../services/admin";
import { runAction } from "./run";

export async function createContractorAction(input: unknown) {
  return runAction(async (ctx) => (await admin.createContractor(ctx, input)).id);
}
export async function updateContractorAction(contractorId: string, input: unknown) {
  return runAction((ctx) => admin.updateContractor(ctx, contractorId, input).then(() => null));
}
export async function uploadContractorPhotoAction(formData: FormData) {
  return runAction(async (ctx) => {
    const contractorId = String(formData.get("contractorId") ?? "");
    const file = formData.get("photo");
    if (!(file instanceof File)) throw new Error("No photo provided");
    await admin.setContractorPhoto(ctx, contractorId, { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type });
    return null;
  });
}
export async function createProjectAction(input: unknown) {
  return runAction(async (ctx) => (await admin.createProject(ctx, input)).id);
}
export async function updateProjectAction(projectId: string, input: unknown) {
  return runAction((ctx) => admin.updateProject(ctx, projectId, input).then(() => null));
}
export async function addContractorToProjectAction(input: unknown) {
  return runAction((ctx) => admin.addContractorToProject(ctx, input).then(() => null));
}
export async function removeContractorFromProjectAction(input: unknown) {
  return runAction((ctx) => admin.removeContractorFromProject(ctx, input).then(() => null));
}
export async function createWorkerAction(input: unknown) {
  return runAction(async (ctx) => {
    const w = await admin.createWorker(ctx, input);
    return { id: w.id, code: w.code, fullName: w.fullName };
  });
}
export async function updateWorkerAction(workerId: string, input: unknown) {
  return runAction((ctx) => admin.updateWorker(ctx, workerId, input).then(() => null));
}
export async function deactivateWorkerAction(workerId: string, input: unknown) {
  return runAction((ctx) => admin.deactivateWorker(ctx, workerId, input).then(() => null));
}
export async function reactivateWorkerAction(workerId: string, input: unknown) {
  return runAction((ctx) => admin.reactivateWorker(ctx, workerId, input).then(() => null));
}
export async function transferWorkerAction(workerId: string, input: unknown) {
  return runAction((ctx) => admin.transferWorker(ctx, workerId, input).then(() => null));
}
export async function createOperatorAction(input: unknown) {
  return runAction(async (ctx) => (await admin.createOperator(ctx, input)).id);
}
export async function setOperatorActiveAction(input: unknown) {
  return runAction((ctx) => admin.setOperatorActive(ctx, input).then(() => null));
}
export async function setOperatorAccessAction(input: unknown) {
  return runAction((ctx) => admin.setOperatorAccess(ctx, input).then(() => null));
}
export async function createPaymentRuleAction(input: unknown) {
  return runAction(async (ctx) => (await admin.createPaymentRule(ctx, input)).version);
}
