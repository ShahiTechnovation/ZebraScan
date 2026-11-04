import type { Metadata } from "next";
import { Settlements } from "@/components/merchant/Settlements";

export const metadata: Metadata = { title: "Settlements" };

export default function Page() {
  return <Settlements />;
}
