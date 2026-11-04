import type { Metadata } from "next";
import { Suspense } from "react";
import { Settings } from "@/components/merchant/Settings";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Settings />
    </Suspense>
  );
}
