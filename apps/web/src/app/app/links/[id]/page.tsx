import type { Metadata } from "next";
import { LinkDetail } from "@/components/merchant/LinkDetail";

export const metadata: Metadata = { title: "Payment link" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LinkDetail id={id} />;
}
