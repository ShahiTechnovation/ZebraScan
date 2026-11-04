import type { Metadata } from "next";
import { LinksList } from "@/components/merchant/Links";

export const metadata: Metadata = { title: "Payment links" };

export default function Page() {
  return <LinksList />;
}
