import type { Metadata } from "next";
import { Receipts } from "@/components/merchant/Receipts";

export const metadata: Metadata = { title: "Receipts" };

export default function Page() {
  return <Receipts />;
}
