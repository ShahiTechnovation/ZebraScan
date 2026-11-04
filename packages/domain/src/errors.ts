/**
 * Typed domain errors. `code` is namespaced (AUTH_*, QR_*, QUOTE_*, WALLET_*, DEPOSIT_*,
 * LIQUIDITY_*, P2P_*, COMPLIANCE_*, LEDGER_*, WITHDRAWAL_*, RATE_*, SYSTEM_*, STATE_*, VALIDATION_*).
 * The API maps these to RFC 7807-style bodies; nothing here knows about HTTP except the
 * suggested status, which keeps the mapping in one place.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly opts: { status?: number; retryable?: boolean; currentStatus?: string } = {},
  ) {
    super(message);
    this.name = "DomainError";
  }

  get status(): number {
    if (this.opts.status) return this.opts.status;
    const p = this.code.split("_")[0];
    switch (p) {
      case "VALIDATION":
      case "QR":
        return 400;
      case "AUTH":
        return this.code === "AUTH_FORBIDDEN" ? 403 : 401;
      case "STATE":
      case "IDEMPOTENCY":
        return 409;
      case "NOT":
        return 404;
      case "RATE":
        return 429;
      case "QUOTE":
      case "LIQUIDITY":
      case "COMPLIANCE":
      case "WALLET":
      case "P2P":
      case "FEATURE":
        return 422;
      case "SYSTEM":
        return 503;
      default:
        return 400;
    }
  }

  get retryable(): boolean {
    return this.opts.retryable ?? false;
  }
}

export function notFound(what: string, id?: string): DomainError {
  return new DomainError("NOT_FOUND", `${what} not found`, id ? { id } : undefined, { status: 404 });
}

export function forbidden(message = "You do not have access to this resource"): DomainError {
  return new DomainError("AUTH_FORBIDDEN", message, undefined, { status: 403 });
}
