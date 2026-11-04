import type { Metadata } from "next";
import { TransactionDetail } from "@/components/merchant/TransactionDetail";

export const metadata: Metadata = { title: "Transaction" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TransactionDetail id={id} />;
}
