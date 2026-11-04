"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Copy as CopyIcon, ExternalLink, Pencil } from "lucide-react";
import { useNow, useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { effectiveLinkStatus, linkUses } from "@/lib/selectors";
import { formatInr } from "@/lib/money";
import { formatDate } from "@/lib/format";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout, DataList, EmptyState, MetricStrip } from "@/components/ui/Blocks";
import { CopyableValue, CopyButton, ShareButton } from "@/components/ui/CopyShare";
import { FormField, Input, Switch, Textarea } from "@/components/ui/Field";
import { ConfirmDialog, Modal } from "@/components/ui/Modal";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/Table";
import { LINK_META, MetaBadge } from "@/components/ui/StatusBadge";
import { QRRenderer } from "@/components/payments/QR";
import { NotFoundPanel } from "@/components/screens/NotFoundPanel";
import { linkAmountLabel } from "./Links";
import { txColumns } from "./shared";

export function LinkDetail({ id }: { id: string }) {
  const router = useRouter();
  const { state, merchant, services } = useZeb();
  const now = useNow(10_000) ?? state.seededAt;
  const { run, busy } = useAction();
  const [origin, setOrigin] = useState("");
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);

  const link = state.links.find((l) => l.id === id && l.merchantId === merchant?.id);
  const [draft, setDraft] = useState({ title: "", description: "", reference: "", allowNote: false });
  if (!merchant) return null;
  if (!link) return <NotFoundPanel title="Payment link not found" body="This link doesn't exist for the current shop." href="/app/links" cta="Back to payment links" />;

  const status = effectiveLinkStatus(state, link, now);
  const uses = linkUses(state, link);
  const payments = state.checkouts.filter((c) => c.linkId === link.id).sort((a, b) => b.createdAt - a.createdAt);
  const received = payments.filter((c) => c.depositStatus === "accepted").reduce((a, c) => a + c.quote.inrMinor, 0);
  const url = `${origin}/pay/${link.slug}`;

  const openEdit = () => {
    setDraft({ title: link.title, description: link.description, reference: link.reference, allowNote: link.allowNote });
    setEditOpen(true);
  };
  const titleErr = draft.title.trim().length < 3 || draft.title.trim().length > 80 ? "Title must be 3–80 characters." : null;

  return (
    <>
      <MerchantPageHeader
        back={{ href: "/app/links", label: "Payment links" }}
        title={link.title}
        badge={<MetaBadge meta={LINK_META[status]} />}
        description={link.description || undefined}
        actions={
          <>
            <Button variant="secondary" onClick={openEdit} disabled={!!link.revokedAt || !services}>
              <Pencil aria-hidden className="h-4 w-4" /> Edit details
            </Button>
            <Button
              variant="secondary"
              isLoading={busy}
              disabled={!services}
              onClick={async () => {
                const r = await run(() => services!.merchant.duplicateLink(link.id), "Link duplicated");
                if (r.ok) router.push(`/app/links/${r.value.id}`);
              }}
            >
              <CopyIcon aria-hidden className="h-4 w-4" /> Duplicate
            </Button>
            {!link.revokedAt && (
              <Button variant="danger" onClick={() => setRevokeOpen(true)} disabled={!services}>
                <Ban aria-hidden className="h-4 w-4" /> Revoke
              </Button>
            )}
          </>
        }
      />

      <MetricStrip
        className="mb-6"
        items={[
          { label: "Successful payments", value: uses, sub: link.reusable ? (link.useLimit ? `of ${link.useLimit} allowed` : "Unlimited") : "One-time link" },
          { label: "Received", value: formatInr(received), sub: "INR credits from this link" },
          { label: "Checkouts started", value: payments.length, sub: "Unconfirmed ones don't count as uses" },
          { label: "Views", value: link.views, sub: "Total customer visits" },
        ]}
      />

      <div className="grid gap-6 xl:grid-cols-12">
        <div className="space-y-6 xl:col-span-8">
          <Panel>
            <PanelHeader title="Share" description="The QR opens the public payment page — it is not a ZEC address." />
            <PanelBody className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
              {origin && (
                <QRRenderer value={url} size={176} label={`QR for the public payment link ${link.title}`} downloadName={`zeb-scan-link-${link.slug}`} downloadTitle={link.title} />
              )}
              <div className="min-w-0 space-y-3">
                {origin && <CopyableValue value={url} label="Link" />}
                <div className="flex flex-wrap gap-2">
                  <CopyButton value={url} label="Copy link" toastMessage="Payment link copied" />
                  <ShareButton url={url} title={link.title} text={`Pay ${merchant.businessName}`} />
                  <ButtonLink href={`/pay/${link.slug}`} variant="ghost" size="sm" target="_blank" rel="noopener">
                    <ExternalLink aria-hidden className="h-4 w-4" /> Open public page
                  </ButtonLink>
                </div>
                {status !== "active" && (
                  <Callout tone="warning">
                    This link is {status}. Visitors see a non-payable page. {status !== "revoked" && "Duplicate it to start selling again."}
                  </Callout>
                )}
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader title="Payments from this link" />
            <DataTable
              rows={payments}
              columns={txColumns(state).filter((c) => c.key !== "kind")}
              rowKey={(c) => c.id}
              onRowHref={(c) => `/app/transactions/${c.id}`}
              caption="Payments from this link"
              mobileTitle={(c) => <span className="font-mono text-label">{c.id}</span>}
              empty={<EmptyState title="No checkouts yet" description="Share the link. Checkouts appear here when a visitor generates one." />}
            />
          </Panel>
        </div>

        <Panel className="h-fit xl:col-span-4">
          <PanelHeader title="Link rules" />
          <PanelBody>
            <DataList
              items={[
                { label: "Amount", value: <span className="num">{link.amountMode === "fixed" ? linkAmountLabel(link) : `Variable · ${linkAmountLabel(link)}`}</span> },
                { label: "Type", value: link.reusable ? "Reusable" : "One-time" },
                { label: "Use limit", value: link.reusable ? (link.useLimit ?? "Unlimited") : "1 confirmed payment" },
                { label: "Expiry", value: link.expiresAt ? formatDate(link.expiresAt) : "None" },
                { label: "Customer note", value: link.allowNote ? "Allowed" : "Off" },
                { label: "Reference", value: link.reference ? <span className="font-mono">{link.reference}</span> : "—" },
                { label: "Created", value: formatDate(link.createdAt) },
                ...(link.revokedAt ? [{ label: "Revoked", value: formatDate(link.revokedAt) }] : []),
                ...(link.duplicatedFrom ? [{ label: "Duplicated from", value: <span className="font-mono text-label">{link.duplicatedFrom}</span> }] : []),
              ]}
            />
            <p className="mt-3 text-micro leading-relaxed text-foreground-muted">
              Amount and usage rules can&apos;t be edited once a link exists, so customers always see the terms they were sent. Duplicate the link to change them.
            </p>
          </PanelBody>
        </Panel>
      </div>

      <ConfirmDialog
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onConfirm={() => run(() => services!.merchant.revokeLink(link.id), "Link revoked")}
        title="Revoke this link?"
        description="Visitors will no longer be able to start a checkout. Payments already confirmed are unaffected; any unconfirmed ZEC that arrives later is held for refund."
        confirmLabel="Revoke link"
        confirmVariant="danger"
      />
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit link details"
        description="Only descriptive details can change. Amount rules are fixed."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={Boolean(titleErr)}
              onClick={async () => {
                const r = await run(() => services!.merchant.updateLink(link.id, draft), "Link updated");
                if (r.ok) setEditOpen(false);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="Title" error={titleErr}>
            {(p) => <Input {...p} value={draft.title} maxLength={80} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />}
          </FormField>
          <FormField label="Description" optional>
            {(p) => <Textarea {...p} value={draft.description} maxLength={240} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}
          </FormField>
          <FormField label="Reference" optional>
            {(p) => <Input {...p} value={draft.reference} maxLength={40} onChange={(e) => setDraft({ ...draft, reference: e.target.value })} />}
          </FormField>
          <Switch checked={draft.allowNote} onChange={(v) => setDraft({ ...draft, allowNote: v })} label="Let customers add a note" />
        </div>
      </Modal>
    </>
  );
}
