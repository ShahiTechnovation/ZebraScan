import type { UiOperationMode } from "@/types/domain";

export function getOperationMode(): UiOperationMode {
  return process.env.NEXT_PUBLIC_ZEB_MODE === "connected" ? "connected" : "demo";
}

export const COPY = {
  brand: "Zeb Scan",
  tagline: "Pay in ZEC. They get INR.",
  heroSupport:
    "Scan a supported UPI QR or collect ZEC through your own checkout. Zeb Scan connects Zcash payments to local settlement experiences.",
  privacyHelper:
    "Shielded ZEC protects on-chain payment details. Fiat payout providers may still see banking information.",
  simulation: "Demo only. These are simulated transactions, not real payments or bank transfers.",
  notConnected: "Live payments are not connected in this build.",
  illustrative: "Illustrative prices · not market data",
  balanceDescriptor: "INR-denominated platform balance",
  balanceSub: "Not yet in your bank account",
  previewQr: "Preview QR — cannot receive real ZEC",
} as const;
