import type { Metadata } from "next";
import { LegalSample } from "@/components/marketing/LegalSample";

export const metadata: Metadata = { title: "Privacy (sample)" };

export default function PrivacyPage() {
  return (
    <LegalSample
      title="Privacy (sample)"
      sections={[
        {
          h: "What this demo stores",
          p: "The demo keeps its sample merchants, links, checkouts and balances in your browser's local storage. Nothing is sent to a Zeb Scan server, because this build has none. Clearing site data or using “Reset demo data” in Settings removes it.",
        },
        {
          h: "Camera and images",
          p: "If you use the QR scanner, the camera feed and uploaded images are processed locally in your browser to read the QR. They are not uploaded or stored.",
        },
        {
          h: "On-chain privacy",
          p: "Shielded Zcash payments hide payment details from public chain observers. A receiving service can identify payments sent to its own addresses, and payout providers and banks see the fiat transfer details they need. Transparent Zcash payments are publicly visible.",
        },
        {
          h: "A live service",
          p: "A live version would need a reviewed privacy policy describing what it collects, why, who it shares data with (such as payout providers), how long it keeps it, and your rights. This sample is not that policy.",
        },
      ]}
    />
  );
}
