import React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "inverse";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
}

export function buttonStyles({ variant = "primary", size = "md" }: { variant?: ButtonVariant; size?: ButtonSize } = {}) {
  const base =
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium select-none transition-[background-color,border-color,color] duration-150 disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45";
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-gold text-ink hover:bg-gold-hover",
    inverse: "bg-foreground text-background hover:opacity-90",
    secondary: "border border-border bg-surface-2 text-foreground hover:border-border-strong hover:bg-surface-3",
    outline: "border border-border-strong bg-transparent text-foreground hover:bg-surface-2",
    ghost: "bg-transparent text-foreground-secondary hover:bg-surface-2 hover:text-foreground",
    danger: "border border-danger/40 bg-danger/10 text-danger hover:bg-danger/15",
  };
  const sizes: Record<ButtonSize, string> = {
    sm: "h-10 px-3.5 text-[13px] md:h-9",
    md: "h-11 px-4 text-[14px] md:h-10",
    lg: "h-12 px-6 text-[15px]",
    icon: "h-11 w-11 md:h-10 md:w-10 p-0",
  };
  return cn(base, variants[variant], sizes[size]);
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", isLoading, disabled, children, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      className={cn(buttonStyles({ variant, size }), className)}
      {...props}
    >
      {isLoading && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

export function ButtonLink({
  href,
  variant,
  size,
  className,
  children,
  ...rest
}: { href: string; variant?: ButtonVariant; size?: ButtonSize; className?: string; children: React.ReactNode } & Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
>) {
  return (
    <Link href={href} className={cn(buttonStyles({ variant, size }), className)} {...rest}>
      {children}
    </Link>
  );
}
