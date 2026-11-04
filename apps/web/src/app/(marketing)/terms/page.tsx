import type { Metadata } from "next";
import { LegalSample } from "@/components/marketing/LegalSample";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return (
    <LegalSample
      title="Terms of Service"
      sections={[
        {
          h: "Payment Rail & Settlement",
          p: "Zeb Scan provides decentralized point-of-sale infrastructure connecting Zcash shielded payments with fiat payout rails. Payment confirmations require on-chain block inclusion in accordance with network consensus.",
        },
        {
          h: "Exchange Rates & Quotes",
          p: "Exchange rate quotes are dynamically computed from multi-source oracle price feeds. Quotes are valid for the designated expiration duration to protect both merchant and payer from adverse market volatility.",
        },
        {
          h: "Merchant Balances & Offramp Settlements",
          p: "Merchant balances represent settled crypto-asset receipts denominated for accounting and withdrawal. Withdrawals are executed to verified bank accounts via peer-to-peer liquidity networks.",
        },
        {
          h: "Non-Custodial Architecture",
          p: "Merchants and customers retain full control of their private spending keys through non-custodial wallets like Noir Wallet. Zeb Scan never stores or requests seed phrases or private spending keys.",
        },
      ]}
    />
  );
}
