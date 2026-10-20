export type AppErrorCode = "unauthenticated" | "forbidden" | "not_found" | "invalid" | "conflict" | "config";

/** Errors that are safe to show to users. Anything else is reported generically. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: AppErrorCode = "invalid",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const forbidden = (msg = "You do not have permission to do this") => new AppError(msg, "forbidden");
export const notFound = (what = "Record") => new AppError(`${what} not found`, "not_found");
export const invalid = (msg: string) => new AppError(msg, "invalid");
export const conflict = (msg: string) => new AppError(msg, "conflict");
