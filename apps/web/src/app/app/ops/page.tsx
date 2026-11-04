import type { Metadata } from "next";
import { Ops } from "@/components/merchant/Ops";

export const metadata: Metadata = { title: "Treasury ops (demo)" };

export default function Page() {
  return <Ops />;
}
