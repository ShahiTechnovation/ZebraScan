import type { Metadata } from "next";
import { ScanPayWizard } from "@/components/screens/ScanPayWizard";

export const metadata: Metadata = { title: "Scan & Pay", description: "Pay a supported UPI QR with ZEC. The receiver gets INR from a payout provider." };

export default function ScanPage() {
  return <ScanPayWizard />;
}
