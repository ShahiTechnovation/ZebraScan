"use client";

import { useCallback, useEffect, useState } from "react";
import { useZeb } from "@/providers/ZebProvider";
import type { PaymentPrivacy, PaymentQuote } from "@/types/domain";

/**
 * Pre-checkout quote preview from the RatesAdapter. Becomes `unavailable`
 * when no adapter is configured (connected mode) — never a fake quote.
 */
export function useQuotePreview(inrMinor: number | null, privacy: PaymentPrivacy) {
  const { services } = useZeb();
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!services || inrMinor === null) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const q = await services.rates.quote(inrMinor, privacy);
        if (!cancelled) {
          setQuote(q);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setQuote(null);
          setError(e instanceof Error ? e.message : "Quote unavailable");
        }
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [services, inrMinor, privacy, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { quote, error, refresh, unavailable: !services };
}
