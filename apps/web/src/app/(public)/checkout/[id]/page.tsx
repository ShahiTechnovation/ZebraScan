import type { Metadata } from "next";
import { HostedCheckout } from "@/components/screens/HostedCheckout";

export const metadata: Metadata = { title: "Checkout", robots: { index: false } };

export default async function CheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <HostedCheckout id={id} />;
}
