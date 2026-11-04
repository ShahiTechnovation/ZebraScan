import type { Metadata } from "next";
import { Help } from "@/components/merchant/Help";

export const metadata: Metadata = { title: "Help" };

export default function Page() {
  return <Help />;
}
