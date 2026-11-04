import type { UiOperationMode } from "@/types/domain";

export function getOperationMode(): UiOperationMode {
  return process.env.NEXT_PUBLIC_ZEB_MODE === "demo" || !process.env.NEXT_PUBLIC_ZEB_MODE ? "demo" : "connected";
}

export const COPY = {
  brand: "Zeb Scan",
  tagline: "Pay with shielded Zcash.",
  heroSupport:
    "Scan a supported UPI QR or collect ZEC through your own checkout. Zeb Scan connects Zcash payments to local settlement experiences.",
  privacyHelper:
    "Shielded ZEC protects on-chain payment details. Fiat payout providers may still see banking information.",
  simulation: "Demo only. These are simulated transactions, not real payments or bank transfers.",
  notConnected: "Payments temporarily unavailable. Your checkout reference is preserved.",
  illustrative: "Timestamped reference rate",
  balanceDescriptor: "Testnet payment records",
  balanceSub: "TAZ reference amounts cannot be withdrawn as INR",
  previewQr: "Scan with your Zcash wallet to pay",
} as const;
