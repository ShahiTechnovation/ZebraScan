import type { Metadata } from "next";
import { LegalSample } from "@/components/marketing/LegalSample";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  return (
    <LegalSample
      title="Privacy Policy"
      sections={[
        {
          h: "Client-side Storage & Security",
          p: "Session tokens, merchant configuration, and view states are securely managed within your browser. Sensitive cryptographic operations involving private keys are executed entirely within non-custodial wallet extensions such as Noir Wallet.",
        },
        {
          h: "Camera and Images",
          p: "If you use the QR scanner, camera feeds and uploaded images are processed locally within your browser using WebAssembly. Camera streams are never transmitted, recorded, or stored on external servers.",
        },
        {
          h: "On-Chain Privacy & Shielded Pools",
          p: "Shielded Zcash payments (Sapling/Orchard) protect payment metadata, sender addresses, and amounts from public block explorers. Invoices generate single-use diversified addresses to prevent correlation.",
        },
        {
          h: "Fiat Settlement Disclosures",
          p: "Settlement payouts to bank accounts via UPI are processed by regulated peer-to-peer liquidity providers. Banking details (such as recipient VPA and beneficiary name) are strictly utilized for settlement delivery.",
        },
      ]}
    />
  );
}
