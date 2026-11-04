import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/layout/AppShell";

export const metadata: Metadata = { title: { default: "Merchant console", template: "%s · Zeb Scan merchant" }, robots: { index: false } };
export const viewport: Viewport = { themeColor: "#0A1012" };

export default function MerchantLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
