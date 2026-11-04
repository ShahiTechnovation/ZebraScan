"use client";

import React, { useId } from "react";
import { AlertCircle, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn("input", className)} {...props} />,
);
Input.displayName = "Input";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn("select", className)} {...props}>
      {children}
    </select>
  ),
);
Select.displayName = "Select";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn("input h-auto min-h-[88px] py-2.5 leading-relaxed", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";

export function SearchInput({
  wrapperClassName,
  className,
  label = "Search",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { wrapperClassName?: string; label?: string }) {
  return (
    <div className={cn("relative", wrapperClassName)}>
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted" />
      <input type="search" aria-label={label} className={cn("input pl-9", className)} {...props} />
    </div>
  );
}

export function InlineError({ children, id, className }: { children: React.ReactNode; id?: string; className?: string }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className={cn("flex items-start gap-1.5 text-label text-danger", className)}>
      <AlertCircle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Label + control + hint/error, with ids wired for a11y via render prop. */
export function FormField({
  label,
  hint,
  error,
  optional,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  optional?: boolean;
  className?: string;
  children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="flex items-baseline justify-between gap-2 text-label font-medium text-foreground-secondary">
        <span>{label}</span>
        {optional && <span className="text-micro font-normal text-foreground-muted">Optional</span>}
      </label>
      {children({ id, "aria-invalid": Boolean(error), "aria-describedby": describedBy })}
      {hint && !error && (
        <p id={hintId} className="text-micro leading-relaxed text-foreground-muted">
          {hint}
        </p>
      )}
      <InlineError id={errId}>{error}</InlineError>
    </div>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: React.ReactNode; count?: number; disabled?: boolean }>;
  className?: string;
  label: string;
  /** "tabs" gives tab semantics (with panels managed by parent); "radio" for form choices. */
  role?: "tabs" | "radio";
  size?: "sm" | "md";
  /** Stretch to full width with equal columns (no horizontal scrolling). */
  fullWidth?: boolean;
}

export function Segmented<T extends string>({ value, onChange, options, className, label, role = "radio", size = "md", fullWidth }: SegmentedProps<T>) {
  const isTabs = role === "tabs";
  return (
    <div
      role={isTabs ? "tablist" : "radiogroup"}
      aria-label={label}
      className={cn(
        "max-w-full items-center gap-0.5 rounded-full border border-border bg-surface-2 p-1",
        fullWidth ? "grid w-full auto-cols-fr grid-flow-col" : "inline-flex overflow-x-auto",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role={isTabs ? "tab" : "radio"}
            aria-selected={isTabs ? active : undefined}
            aria-checked={isTabs ? undefined : active}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors duration-150 disabled:opacity-40",
              fullWidth && "min-w-0 justify-center px-2",
              size === "sm" ? "h-8 px-3 text-label" : fullWidth ? "h-10 text-[13px]" : "h-9 px-3.5 text-[13px]",
              active ? "bg-surface-1 text-foreground shadow-panel ring-1 ring-border-strong" : "text-foreground-secondary hover:text-foreground",
            )}
          >
            {o.label}
            {o.count !== undefined && <span className="num text-micro text-foreground-muted">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[14px] font-medium text-foreground">
          {label}
        </label>
        {description && <p className="mt-0.5 text-label leading-relaxed text-foreground-secondary">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-40",
          checked ? "border-gold bg-gold" : "border-border-strong bg-surface-3",
        )}
      >
        <span className="sr-only">{checked ? "On" : "Off"}</span>
        <span
          aria-hidden
          className={cn(
            "inline-block h-5 w-5 rounded-full shadow transition-transform duration-150",
            checked ? "translate-x-6 bg-ink" : "translate-x-1 bg-foreground-secondary",
          )}
        />
      </button>
    </div>
  );
}
