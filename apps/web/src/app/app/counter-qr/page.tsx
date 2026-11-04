import type { Metadata } from "next";
import { CounterQr } from "@/components/merchant/CounterQr";

export const metadata: Metadata = { title: "Counter QR" };

export default function CounterQrPage() {
  return <CounterQr />;
}
