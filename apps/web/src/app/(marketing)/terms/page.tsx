import type { Metadata } from "next";
import { LegalSample } from "@/components/marketing/LegalSample";

export const metadata: Metadata = { title: "Terms (sample)" };

export default function TermsPage() {
  return (
    <LegalSample
      title="Terms (sample)"
      sections={[
        {
          h: "Demo only",
          p: "This build is a demonstration. All quotes, deposits, merchant credits, withdrawals and payouts are simulated. Do not send real ZEC to any address or QR shown here; demo QR codes encode non-payable placeholders.",
        },
        {
          h: "No guarantees",
          p: "Prices shown are illustrative, not market data. Nothing here is an offer, a promise of payout timing, or a statement about any regulatory status.",
        },
        {
          h: "Merchant balances",
          p: "In a live service, a merchant balance would be an INR-denominated platform liability, not a bank deposit. Settlement policies such as cooldown periods shown in the demo are examples only.",
        },
        {
          h: "Third parties",
          p: "A live service would rely on third parties such as Zcash wallet infrastructure, USDC on Base and P2P liquidity providers. Zeb Scan is not affiliated with or endorsed by those parties.",
        },
      ]}
    />
  );
}
