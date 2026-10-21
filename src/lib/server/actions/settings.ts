"use server";

import * as settings from "../services/settings";
import { runAction } from "./run";

export async function createPolicyVersionAction(input: unknown) {
  return runAction(async (ctx) => (await settings.createPolicyVersion(ctx, input)).version);
}
