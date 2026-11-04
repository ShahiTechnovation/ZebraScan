import type { Metadata } from "next";
import { StartCheckout } from "@/components/screens/StartCheckout";

export const metadata: Metadata = { title: "Pay with ZEC", robots: { index: false } };

export default async function PayLinkPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <StartCheckout kind="link" slug={decodeURIComponent(slug)} />;
}
