import React from "react";
import { cn } from "@/lib/utils";

interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  as?: "div" | "section" | "article" | "aside";
  inset?: boolean;
}

export function Panel({ as: Tag = "div", inset, className, children, ...props }: PanelProps) {
  return (
    <Tag className={cn(inset ? "panel-inset" : "panel", "min-w-0", className)} {...props}>
      {children}
    </Tag>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
  icon,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5", className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && <span className="mt-0.5 shrink-0 text-foreground-secondary [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] leading-relaxed text-foreground-secondary">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PanelBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 sm:p-5", className)} {...props} />;
}

export function PanelFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-t border-border px-4 py-3 sm:px-5", className)} {...props} />;
}

export function SectionHeading({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div>
        <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-foreground-secondary">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
