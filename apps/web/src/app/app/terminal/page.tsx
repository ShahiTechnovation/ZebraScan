import type { Metadata } from "next";
import { Suspense } from "react";
import { Terminal } from "@/components/merchant/Terminal";

export const metadata: Metadata = { title: "QR Terminal" };

export default function TerminalPage() {
  return (
    <Suspense fallback={null}>
      <Terminal />
    </Suspense>
  );
}
