export type ErrorCode =
  | "USAGE"
  | "VALIDATION"
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "CONFIG"
  | "NETWORK"
  | "UPSTREAM"
  | "TIMEOUT"
  | "NO_ROUTE"
  | "POLICY_REJECTED"
  | "QUOTE_EXPIRED"
  | "DEPOSIT_UNSUPPORTED"
  | "DEPOSIT_EXPIRED"
  | "ADDRESS_INVALID"
  | "SIGNER_UNAVAILABLE"
  | "SIGNING_REJECTED"
  | "BROADCAST_FAILED"
  | "BROADCAST_UNKNOWN"
  | "RECEIPT_NOT_FOUND"
  | "INTERRUPTED"
  | "INTERNAL";

const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE: 2,
  VALIDATION: 2,
  AUTH_REQUIRED: 3,
  AUTH_INVALID: 3,
  CONFIG: 3,
  NETWORK: 5,
  UPSTREAM: 5,
  TIMEOUT: 5,
  NO_ROUTE: 4,
  POLICY_REJECTED: 4,
  QUOTE_EXPIRED: 4,
  DEPOSIT_UNSUPPORTED: 4,
  DEPOSIT_EXPIRED: 4,
  ADDRESS_INVALID: 2,
  SIGNER_UNAVAILABLE: 6,
  SIGNING_REJECTED: 6,
  BROADCAST_FAILED: 7,
  BROADCAST_UNKNOWN: 7,
  RECEIPT_NOT_FOUND: 2,
  INTERRUPTED: 130,
  INTERNAL: 1
};

export interface ErrorAction {
  label: string;
  command?: string;
}

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly retryable: boolean;
  readonly fundsMayHaveMoved: boolean;
  readonly actions: ErrorAction[];
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: {
      retryable?: boolean;
      fundsMayHaveMoved?: boolean;
      actions?: ErrorAction[];
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {}
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = "CliError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.retryable = opts.retryable ?? (code === "NETWORK" || code === "UPSTREAM" || code === "TIMEOUT");
    // BROADCAST_UNKNOWN means precisely "a transaction may already be
    // on-chain", so it carries funds_may_have_moved by construction instead of
    // relying on every call site to remember. Agents key their stop-and-verify
    // behaviour on this field, and a false negative is the dangerous direction:
    // it invites the retry that double-spends.
    this.fundsMayHaveMoved = opts.fundsMayHaveMoved ?? code === "BROADCAST_UNKNOWN";
    this.actions = opts.actions ?? [];
    this.details = opts.details;
  }
}

export function asCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof Error) {
    return new CliError("INTERNAL", err.message, { cause: err });
  }
  return new CliError("INTERNAL", String(err));
}
