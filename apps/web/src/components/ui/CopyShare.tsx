"use client";

import React, { useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/providers/ToastProvider";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = "Copy",
  toastMessage,
  variant = "secondary",
  size = "sm",
  iconOnly,
  className,
}: {
  value: string;
  label?: string;
  toastMessage?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  className?: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    const ok = await writeClipboard(value);
    if (ok) {
      setCopied(true);
      toast(toastMessage ?? "Copied to clipboard");
      window.setTimeout(() => setCopied(false), 1600);
    } else {
      toast("Couldn't access the clipboard. Select and copy manually.", "error");
    }
  };
  const Icon = copied ? Check : Copy;
  return (
    <Button variant={variant} size={iconOnly ? "icon" : size} onClick={onClick} aria-label={iconOnly ? label : undefined} className={className}>
      <Icon aria-hidden className={cn("h-4 w-4", copied && "text-success")} />
      {!iconOnly && <span>{copied ? "Copied" : label}</span>}
    </Button>
  );
}

export function ShareButton({
  url,
  title,
  text,
  label = "Share",
  variant = "secondary",
  size = "sm",
}: {
  url: string;
  title: string;
  text?: string;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const toast = useToast();
  const onClick = async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url, title, text });
        toast("Shared");
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return;
      }
    }
    const ok = await writeClipboard(url);
    toast(ok ? "Sharing isn't available here — link copied instead" : "Couldn't share or copy the link", ok ? "info" : "error");
  };
  return (
    <Button variant={variant} size={size} onClick={onClick}>
      <Share2 aria-hidden className="h-4 w-4" />
      {label}
    </Button>
  );
}

/** Mono value + copy button, for addresses, ids, amounts. */
export function CopyableValue({ value, display, label, className }: { value: string; display?: React.ReactNode; label: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 rounded-input border border-border bg-surface-2 py-1 pl-3 pr-1", className)}>
      <span className="min-w-0 flex-1 break-all font-mono text-[12px] leading-relaxed text-foreground">{display ?? value}</span>
      <CopyButton value={value} label={`Copy ${label}`} toastMessage={`${label} copied`} iconOnly variant="ghost" />
    </div>
  );
}
