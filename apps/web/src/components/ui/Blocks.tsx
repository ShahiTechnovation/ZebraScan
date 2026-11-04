import React from "react";
import { AlertTriangle, CheckCircle2, Info, ShieldAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      {Icon && (
        <span className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-full border border-border bg-surface-2 text-foreground-secondary">
          <Icon aria-hidden className="h-5 w-5" />
        </span>
      )}
      <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-foreground-secondary">{description}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

const CALLOUT: Record<string, { icon: LucideIcon; cls: string }> = {
  info: { icon: Info, cls: "border-progress/30 bg-progress/[0.06] [&_.ci]:text-progress" },
  warning: { icon: AlertTriangle, cls: "border-warning/35 bg-warning/[0.07] [&_.ci]:text-warning" },
  danger: { icon: ShieldAlert, cls: "border-danger/35 bg-danger/[0.07] [&_.ci]:text-danger" },
  success: { icon: CheckCircle2, cls: "border-success/30 bg-success/[0.06] [&_.ci]:text-success" },
  demo: { icon: Info, cls: "border-gold/45 bg-gold/[0.08] [&_.ci]:text-accent" },
};

export function Callout({
  tone = "info",
  title,
  children,
  action,
  className,
  icon,
}: {
  tone?: keyof typeof CALLOUT;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  icon?: LucideIcon;
}) {
  const c = CALLOUT[tone]!;
  const Icon = icon ?? c.icon;
  return (
    <div className={cn("flex gap-3 rounded-panel border px-3.5 py-3", c.cls, className)} role={tone === "danger" ? "alert" : undefined}>
      <Icon aria-hidden className="ci mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground-secondary">
        {title && <p className="font-medium text-foreground">{title}</p>}
        {children && <div className={cn(title && "mt-0.5")}>{children}</div>}
        {action && <div className="mt-2.5 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}

export function DataList({ items, className }: { items: Array<{ label: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode }>; className?: string }) {
  return (
    <dl className={cn("divide-y divide-border", className)}>
      {items.map((it, i) => (
        <div key={i} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
          <dt className="shrink-0 text-label text-foreground-secondary">{it.label}</dt>
          <dd className="min-w-0 break-words text-[13px] text-foreground sm:text-right">
            {it.value}
            {it.hint && <div className="text-micro text-foreground-muted">{it.hint}</div>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function MetricStrip({
  items,
  className,
}: {
  items: Array<{ label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode; icon?: LucideIcon }>;
  className?: string;
}) {
  return (
    <div className={cn("panel grid grid-cols-2 divide-border lg:grid-cols-4 lg:divide-x", className)}>
      {items.map((m, i) => (
        <div
          key={i}
          className={cn(
            "min-w-0 px-4 py-4 sm:px-5",
            i % 2 === 1 && "border-l border-border lg:border-l-0",
            i >= 2 && "border-t border-border lg:border-t-0",
          )}
        >
          <p className="flex items-center gap-1.5 text-label text-foreground-secondary">
            {m.icon && <m.icon aria-hidden className="h-3.5 w-3.5" />}
            {m.label}
          </p>
          <p className="num mt-1.5 truncate font-display text-[20px] font-semibold tracking-[-0.02em] text-foreground sm:text-[24px]">{m.value}</p>
          {m.sub && <p className="mt-0.5 truncate text-micro text-foreground-muted">{m.sub}</p>}
        </div>
      ))}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-input bg-surface-3/70", className)} />;
}

export function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function KeyValue({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-label text-foreground-secondary">{label}</p>
      <div className="mt-0.5 min-w-0 break-words text-[14px] text-foreground">{children}</div>
    </div>
  );
}
