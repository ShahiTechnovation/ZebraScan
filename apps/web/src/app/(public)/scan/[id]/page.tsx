import type { Metadata } from "next";
import { ScanStatus } from "@/components/screens/ScanStatus";

export const metadata: Metadata = { title: "Scan & Pay status" };

export default async function ScanStatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ScanStatus id={id} />;
}
