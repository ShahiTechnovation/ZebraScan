import type { Metadata } from "next";
import { ReceiptDetail } from "@/components/merchant/Receipts";

export const metadata: Metadata = { title: "Receipt" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReceiptDetail id={id} />;
}
