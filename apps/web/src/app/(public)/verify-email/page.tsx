import { Suspense } from "react";
import { VerifyEmail } from "@/components/screens/AccountToken";

export const metadata = { title: "Verify email · Zeb Scan", robots: { index: false } };

export default function Page() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
