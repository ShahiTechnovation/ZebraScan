import type { Metadata } from "next";
import { PublicShell } from "@/components/layout/PublicShell";
import { NotFoundPanel } from "@/components/screens/NotFoundPanel";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <PublicShell>
      <NotFoundPanel title="Page not found" body="This page doesn't exist. Check the address, or head back to the start." href="/" cta="Go to Zeb Scan home" />
    </PublicShell>
  );
}
