import { PublicShell } from "@/components/layout/PublicShell";

export default function PublicFlowLayout({ children }: { children: React.ReactNode }) {
  return <PublicShell minimal>{children}</PublicShell>;
}
