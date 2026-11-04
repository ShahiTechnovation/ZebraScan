import type { Metadata } from "next";
import { Withdrawals } from "@/components/merchant/Withdrawals";

export const metadata: Metadata = { title: "Withdrawals" };

export default function Page() {
  return <Withdrawals />;
}
