"use server";

import { saveAttendance as saveAttendanceService, type SaveResult } from "../services/attendance";
import { runAction, type ActionResult } from "./run";

export async function saveAttendanceAction(batch: unknown): Promise<ActionResult<SaveResult>> {
  return runAction((ctx) => saveAttendanceService(ctx, batch));
}
