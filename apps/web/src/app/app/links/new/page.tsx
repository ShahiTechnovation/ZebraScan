import type { Metadata } from "next";
import { LinkNew } from "@/components/merchant/LinkNew";

export const metadata: Metadata = { title: "Create payment link" };

export default function Page() {
  return <LinkNew />;
}
