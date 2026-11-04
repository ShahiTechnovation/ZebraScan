import type { Metadata } from "next";
import { PublicReceipt } from "@/components/screens/PublicReceipt";

export const metadata: Metadata = { title: "Receipt", robots: { index: false } };

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PublicReceipt id={id} />;
}
