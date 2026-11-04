import type { Metadata } from "next";
import { WithdrawalDetail } from "@/components/merchant/WithdrawalDetail";

export const metadata: Metadata = { title: "Withdrawal" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WithdrawalDetail id={id} />;
}
