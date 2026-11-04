"use client";

import React, { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, type ButtonVariant } from "./Button";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function useDialogBehaviour(open: boolean, onCloseProp: () => void, ref: React.RefObject<HTMLDivElement | null>) {
  const closeRef = useRef(onCloseProp);
  closeRef.current = onCloseProp;
  useEffect(() => {
    if (!open) return;
    const onClose = () => closeRef.current();
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>("[data-autofocus]") ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab" && node) {
        const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) return;
        const a = items[0]!;
        const z = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, ref]);
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useDialogBehaviour(open, onClose, ref);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div aria-hidden className="absolute inset-0 bg-black/55 animate-fade-in" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cn(
          "relative z-10 max-h-[92vh] w-full overflow-y-auto rounded-t-overlay border border-border bg-surface-1 text-foreground shadow-overlay animate-scale-in sm:rounded-overlay",
          size === "sm" ? "sm:max-w-sm" : size === "md" ? "sm:max-w-md" : "sm:max-w-xl",
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-5">
          <div>
            <h2 id={titleId} className="text-[16px] font-semibold tracking-[-0.01em]">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-[13px] leading-relaxed text-foreground-secondary">
                {description}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="-mr-2 -mt-1 rounded-full p-2 text-foreground-secondary hover:bg-surface-2 hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children && <div className="px-5 pb-5 text-[14px]">{children}</div>}
        {footer && <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  confirmVariant = "primary",
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  children?: React.ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-autofocus>
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  side = "left",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  side?: "left" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogBehaviour(open, onClose, ref);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60]">
      <div aria-hidden className="absolute inset-0 bg-black/55 animate-fade-in" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "absolute inset-y-0 flex w-[86vw] max-w-[320px] flex-col overflow-y-auto border-border bg-surface-nav text-foreground shadow-overlay animate-slide-in",
          side === "left" ? "left-0 border-r" : "right-0 border-l",
        )}
      >
        {children}
      </div>
    </div>
  );
}
