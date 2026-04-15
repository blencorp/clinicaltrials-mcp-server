export type CtGovErrorCode =
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_HTTP_ERROR"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "SANDBOX_ERROR"
  | "SANDBOX_TIMEOUT"
  | "SANDBOX_MEMORY"
  | "POLICY_VIOLATION"
  | "INTERNAL_ERROR";

export class CtGovError extends Error {
  public readonly code: CtGovErrorCode;
  public readonly status?: number;
  public readonly details?: unknown;

  constructor(
    code: CtGovErrorCode,
    message: string,
    opts: { status?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "CtGovError";
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.details !== undefined) this.details = opts.details;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      message: this.message,
    };
    if (this.status !== undefined) out.status = this.status;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}
