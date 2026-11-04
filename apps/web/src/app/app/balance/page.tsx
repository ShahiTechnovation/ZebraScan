import type { Metadata } from "next";
import { Balance } from "@/components/merchant/Balance";

export const metadata: Metadata = { title: "Balance" };

export default function Page() {
  return <Balance />;
}
