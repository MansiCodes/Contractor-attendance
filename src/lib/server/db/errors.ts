import { AppError, conflict, forbidden, invalid } from "@/lib/errors";

// Database errors become user-safe AppErrors. Messages raised by the SQL functions
// start with "forbidden:", "invalid:" or "conflict:"; everything else is reported
// generically (the detail goes to the server log, not the browser).

export function mapDbError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const e = error as { message?: string; code?: string };
  const msg = e?.message ?? "Database error";
  const m = /^(forbidden|invalid|conflict):\s*(.*)$/s.exec(msg);
  if (m) {
    const text = m[2].charAt(0).toUpperCase() + m[2].slice(1);
    return m[1] === "forbidden" ? forbidden(text) : m[1] === "conflict" ? conflict(text) : invalid(text);
  }
  switch (e?.code) {
    case "42501":
      return forbidden("You do not have permission to do this");
    case "23505":
      return conflict("This record already exists");
    case "23P01":
      return conflict("These dates overlap an existing plant assignment");
    case "23514":
      return invalid("The values entered are not allowed (check times and numbers)");
    case "23503":
      return invalid("A linked record does not exist");
    case "40001":
    case "40P01":
      return conflict("Someone else saved at the same moment. Please try again.");
    default:
      console.error("[db] unexpected error", e?.code, msg);
      return new AppError("The database could not complete this request. Please try again.", "config");
  }
}
