import type { Metadata } from "next";
import { Transactions } from "@/components/merchant/Transactions";

export const metadata: Metadata = { title: "Transactions" };

export default function Page() {
  return <Transactions />;
}
