import { Suspense } from "react";
import { ResetPassword } from "@/components/screens/AccountToken";

export const metadata = { title: "Reset password · Zeb Scan", robots: { index: false } };

export default function Page() {
  return (
    <Suspense>
      <ResetPassword />
    </Suspense>
  );
}
