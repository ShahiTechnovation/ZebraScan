"use client";

import React, { useEffect, useState } from "react";
import { ExternalLink, Printer, RefreshCcw } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { ZebMark } from "@/components/brand/ZebLogo";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Blocks";
import { CopyableValue, CopyButton, ShareButton } from "@/components/ui/CopyShare";
import { ConfirmDialog } from "@/components/ui/Modal";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { QRRenderer } from "@/components/payments/QR";

export function CounterQr() {
  const { merchant, services } = useZeb();
  const { run } = useAction();
  const [origin, setOrigin] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  if (!merchant) return null;
  const url = `${origin}/m/${merchant.counterSlug}`;

  return (
    <>
      <MerchantPageHeader
        title="Your counter, one scan away"
        description="A permanent QR for your counter. It opens your hosted checkout, where the customer enters the amount and gets a fresh ZEC quote and a new receiving address each time."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div>
          <div className="print-area theme-light rounded-overlay border border-border bg-surface-1 p-6 text-center text-foreground">
            <div className="flex items-center justify-center gap-2">
              <ZebMark size={28} />
              <span className="font-display text-[15px] font-semibold">Zeb Scan</span>
            </div>
            <p className="mt-5 font-display text-[24px] font-semibold tracking-[-0.02em]">{merchant.businessName}</p>
            <p className="mt-1 text-[14px] text-foreground-secondary">Scan to pay with ZEC</p>
            {origin && (
              <QRRenderer
                className="mt-5"
                value={url}
                size={220}
                label={`QR linking to ${merchant.businessName}'s Zeb Scan checkout page`}
                caption="Opens your checkout page — not a ZEC address"
              />
            )}
            <p className="mt-4 break-all font-mono text-micro text-foreground-muted">{url.replace(/^https?:\/\//, "")}</p>
          </div>
          {origin && (
            <div className="no-print mt-4 flex flex-wrap justify-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => window.print()}>
                <Printer aria-hidden className="h-4 w-4" /> Print
              </Button>
              <DownloadCounter url={url} name={merchant.businessName} />
            </div>
          )}
        </div>

        <div className="space-y-6">
          <Panel>
            <PanelHeader title="Counter checkout URL" />
            <PanelBody className="space-y-3">
              {origin && <CopyableValue value={url} label="Counter URL" />}
              <div className="flex flex-wrap gap-2">
                <CopyButton value={url} label="Copy URL" toastMessage="Counter URL copied" />
                <ShareButton url={url} title={`Pay ${merchant.businessName}`} />
                <ButtonLink href={`/m/${merchant.counterSlug}`} variant="ghost" size="sm" target="_blank" rel="noopener">
                  <ExternalLink aria-hidden className="h-4 w-4" /> Open checkout page
                </ButtonLink>
              </div>
            </PanelBody>
          </Panel>
          <Callout tone="info" title="Two different QR codes">
            This counter QR is permanent and points to your checkout page. The ZEC payment QR the customer then sees is created per payment, expires after 90 seconds and
            uses a unique address. The counter QR never contains a ZEC deposit address.
          </Callout>
          <Panel>
            <PanelHeader title="Regenerate link" description="If your printed QR is lost or misused, replace it." />
            <PanelBody>
              <Button variant="danger" onClick={() => setConfirm(true)} disabled={!services}>
                <RefreshCcw aria-hidden className="h-4 w-4" /> Regenerate counter link
              </Button>
            </PanelBody>
          </Panel>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => services && run(() => services.merchant.regenerateCounterSlug(merchant.id), "Counter link regenerated")}
        title="Regenerate counter link?"
        description="Your current printed QR will stop opening a checkout. Customers who scan it will see a 'replaced' message. You'll need to print the new QR."
        confirmLabel="Regenerate"
        confirmVariant="danger"
      />
    </>
  );
}

function DownloadCounter({ url, name }: { url: string; name: string }) {
  // PNG is generated from the same payload as the displayed QR.
  return (
    <div>
      <QRRenderer downloadOnly value={url} label="Counter QR download" downloadName={`zeb-scan-counter-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} downloadTitle={`${name} · Scan to pay with ZEC`} />
    </div>
  );
}
