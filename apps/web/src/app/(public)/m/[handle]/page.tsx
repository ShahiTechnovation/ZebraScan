import type { Metadata } from "next";
import { StartCheckout } from "@/components/screens/StartCheckout";

export const metadata: Metadata = { title: "Pay at the counter", robots: { index: false } };

export default async function CounterLandingPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return <StartCheckout kind="counter" slug={decodeURIComponent(handle)} />;
}
