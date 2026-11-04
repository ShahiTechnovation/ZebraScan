import type { PaymentQuote } from "@/types/domain";
export function isQuoteExpired(quote: PaymentQuote, now: number): boolean {
  return now >= quote.expiresAt;
}

export function validateInrAmount(minor: number | null): string | null {
  if (minor === null) return "Enter an INR amount.";
  if (minor <= 0) return "Amount must be greater than zero.";
  if (!Number.isSafeInteger(minor)) return "Amount exceeds supported precision.";
  return null;
}
