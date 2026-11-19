/** An error that is safe to show to the user. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const forbidden = (message = "You do not have permission to do this.") =>
  new AppError(403, "FORBIDDEN", message);
export const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Please sign in.");
export const notFound = (what = "Record") => new AppError(404, "NOT_FOUND", `${what} not found.`);
