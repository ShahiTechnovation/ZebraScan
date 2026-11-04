import React from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  Hourglass,
  Lock,
  LockOpen,
  RefreshCcw,
  ShieldAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CreditStatus, DepositStatus, P2PStatus, PaymentLinkStatus, WithdrawalStatus } from "@/types/domain";

export type Tone = "success" | "progress" | "warning" | "danger" | "neutral" | "accent";

const toneClass: Record<Tone, string> = {
  success: "bg-success/10 text-success ring-success/30",
  progress: "bg-progress/10 text-progress ring-progress/30",
  warning: "bg-warning/10 text-warning ring-warning/30",
  danger: "bg-danger/10 text-danger ring-danger/30",
  neutral: "bg-surface-3/60 text-foreground-secondary ring-border-strong",
  accent: "bg-gold/10 text-accent ring-gold/40",
};

export function StatusBadge({ tone, icon: Icon, children, className }: { tone: Tone; icon?: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-micro font-medium ring-1 ring-inset",
        toneClass[tone],
        className,
      )}
    >
      {Icon && <Icon aria-hidden className="h-3 w-3 shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

type Meta = { label: string; tone: Tone; icon: LucideIcon };

export const DEPOSIT_META: Record<DepositStatus, Meta> = {
  awaiting: { label: "Waiting for ZEC", tone: "progress", icon: Hourglass },
  detected: { label: "ZEC detected", tone: "progress", icon: CircleDashed },
  confirming: { label: "ZEC detected · confirming", tone: "progress", icon: CircleDashed },
  accepted: { label: "ZEC payment verified", tone: "success", icon: CheckCircle2 },
  expired: { label: "Quote expired", tone: "neutral", icon: Clock },
  underpaid: { label: "Underpaid", tone: "warning", icon: AlertTriangle },
  overpaid: { label: "Overpaid", tone: "warning", icon: AlertTriangle },
  late: { label: "Late payment", tone: "warning", icon: AlertTriangle },
  refund_pending: { label: "Refund pending", tone: "warning", icon: RefreshCcw },
  refunded: { label: "Refunded", tone: "neutral", icon: RefreshCcw },
  under_review: { label: "Under review", tone: "warning", icon: ShieldAlert },
};

export const P2P_META: Record<P2PStatus, Meta> = {
  not_started: { label: "Not started", tone: "neutral", icon: CircleDashed },
  placed: { label: "Order queued", tone: "progress", icon: Hourglass },
  accepted: { label: "Provider accepted", tone: "progress", icon: CircleDashed },
  usdc_escrowed: { label: "USDC escrowed", tone: "progress", icon: Lock },
  inr_processing: { label: "INR processing", tone: "progress", icon: CircleDashed },
  completed: { label: "Payout completed", tone: "success", icon: CheckCircle2 },
  cancelled: { label: "Cancelled", tone: "neutral", icon: Ban },
  failed: { label: "Payout failed", tone: "danger", icon: XCircle },
  disputed: { label: "Disputed", tone: "warning", icon: ShieldAlert },
  under_review: { label: "Under review", tone: "warning", icon: ShieldAlert },
};

export const CREDIT_META: Record<CreditStatus, Meta> = {
  pending: { label: "Pending verification", tone: "progress", icon: Hourglass },
  locked: { label: "Locked", tone: "warning", icon: Lock },
  available: { label: "Available", tone: "success", icon: LockOpen },
  withdrawal_reserved: { label: "Reserved for withdrawal", tone: "progress", icon: Clock },
  withdrawn: { label: "Withdrawn", tone: "neutral", icon: CheckCircle2 },
};

export const WITHDRAWAL_META: Record<WithdrawalStatus, Meta> = {
  requested: { label: "Requested", tone: "progress", icon: Hourglass },
  matching: { label: "Finding a payout provider", tone: "progress", icon: CircleDashed },
  accepted: { label: "Provider accepted", tone: "progress", icon: CircleDashed },
  escrowed: { label: "USDC escrowed", tone: "progress", icon: Lock },
  processing: { label: "INR transfer in progress", tone: "progress", icon: CircleDashed },
  completed: { label: "Payout completed", tone: "success", icon: CheckCircle2 },
  failed: { label: "Failed", tone: "danger", icon: XCircle },
  disputed: { label: "Disputed", tone: "warning", icon: ShieldAlert },
  cancelled: { label: "Cancelled", tone: "neutral", icon: Ban },
  cancelling: { label: "Cancelling", tone: "progress", icon: Hourglass },
  under_review: { label: "Under review", tone: "warning", icon: ShieldAlert },
};

export const LINK_META: Record<PaymentLinkStatus, Meta> = {
  active: { label: "Active", tone: "success", icon: CheckCircle2 },
  expired: { label: "Expired", tone: "neutral", icon: Clock },
  revoked: { label: "Revoked", tone: "danger", icon: Ban },
  exhausted: { label: "Exhausted", tone: "neutral", icon: Lock },
};

export function MetaBadge({ meta, label, className }: { meta: Meta; label?: string; className?: string }) {
  return (
    <StatusBadge tone={meta.tone} icon={meta.icon} className={className}>
      {label ?? meta.label}
    </StatusBadge>
  );
}

export function DemoBadge({ className, label = "Demo" }: { className?: string; label?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full bg-mineral px-2.5 font-mono text-micro font-semibold uppercase tracking-[0.08em] text-ink",
        className,
      )}
    >
      {label}
    </span>
  );
}
