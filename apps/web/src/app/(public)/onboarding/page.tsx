import type { Metadata } from "next";
import { Onboarding } from "@/components/screens/Onboarding";

export const metadata: Metadata = { title: "Merchant setup" };

export default function OnboardingPage() {
  return <Onboarding />;
}
