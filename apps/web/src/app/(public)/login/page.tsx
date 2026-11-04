import type { Metadata } from "next";
import { Suspense } from "react";
import { Login } from "@/components/screens/Login";

export const metadata: Metadata = { title: "Merchant sign in" };

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <Login />
    </Suspense>
  );
}
