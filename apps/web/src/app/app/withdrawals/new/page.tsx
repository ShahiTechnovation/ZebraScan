import type { Metadata } from "next";
import { WithdrawalNew } from "@/components/merchant/WithdrawalNew";

export const metadata: Metadata = { title: "New withdrawal" };

export default function Page() {
  return <WithdrawalNew />;
}
