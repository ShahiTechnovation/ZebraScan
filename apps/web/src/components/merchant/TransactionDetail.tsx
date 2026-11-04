"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EyeOff, ReceiptText } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { checkoutTitle } from "@/lib/selectors";
import { formatInr, formatZec } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/format";
import { modeLabel } from "@/services/model";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { ButtonLink } from "@/components/ui/Button";
import { Callout, DataList } from "@/components/ui/Blocks";
import { CopyableValue } from "@/components/ui/CopyShare";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/Panel";
import { CREDIT_META, MetaBadge } from "@/components/ui/StatusBadge";
import { EventLog } from "@/components/ui/Timeline";
import { CheckoutPanel } from "@/components/payments/CheckoutPanel";
import { DepositProgress } from "@/components/payments/Progress";
import { PrivacyBadge } from "@/components/payments/Quote";
import { NotFoundPanel } from "@/components/screens/NotFoundPanel";
import { CheckoutStatus } from "./shared";

export function TransactionDetail({ id }: { id: string }) {
  const router = useRouter();
  const { state, merchant, isDemo } = useZeb();
  if (!merchant) return null;
  const c = state.checkouts.find((x) => x.id === id && x.merchantId === merchant.id);
  if (!c) return <NotFoundPanel title="Transaction not found" body="No transaction with this id exists for the current shop." href="/app/transactions" cta="Back to transactions" />;

  const credits = state.credits.filter((cr) => cr.checkoutId === c.id);
  const root = credits.find((cr) => !cr.parentCreditId);
  const link = c.linkId ? state.links.find((l) => l.id === c.linkId) : undefined;
  const receipt = state.receipts.find((r) => r.checkoutId === c.id);
  const ledger = state.ledger.filter((l) => l.refId === c.id || credits.some((cr) => cr.id === l.refId));
  const live = ["awaiting", "detected", "confirming", "expired", "underpaid", "overpaid", "late", "refund_pending"].includes(c.depositStatus);

  return (
    <>
      <MerchantPageHeader
        back={{ href: "/app/transactions", label: "Transactions" }}
        title={`${formatInr(c.quote.inrMinor)} · ${checkoutTitle(state, c)}`}
        badge={<CheckoutStatus c={c} credit={root} />}
        actions={
          receipt && (
            <ButtonLink href={`/app/receipts/${receipt.id}`} variant="secondary">
              <ReceiptText aria-hidden className="h-4 w-4" /> Receipt
            </ButtonLink>
          )
        }
      />
      <div className="grid gap-6 xl:grid-cols-12">
        <div className="min-w-0 space-y-6 xl:col-span-8">
          {live && (
            <Panel>
              <PanelHeader title="Payment request" description="The customer-facing checkout for this payment" />
              <PanelBody>
                <CheckoutPanel checkout={c} compactHeader onNewCheckout={(nid) => router.push(`/app/transactions/${nid}`)} />
              </PanelBody>
            </Panel>
          )}
          <Panel>
            <PanelHeader title="Zcash verification & accounting" description="Wallet verification first, then the merchant credit" />
            <PanelBody className="grid gap-8 md:grid-cols-2">
              <div>
                <p className="mb-3 text-label font-medium text-foreground-secondary">Status</p>
                <DepositProgress checkout={c} credit={root} />
              </div>
              <div>
                <p className="mb-3 text-label font-medium text-foreground-secondary">Event log</p>
                <EventLog events={[...c.events, ...ledger.map((l) => ({ at: l.at, label: l.description, detail: `${l.direction === "debit" ? "−" : l.direction === "credit" ? "+" : ""}${formatInr(l.inrMinor)} · ledger` }))]} />
              </div>
            </PanelBody>
          </Panel>
          {c.exceptionReason && (
            <Callout tone="warning" title="Exception">
              {c.exceptionReason} Refunds and recovery are handled from the payment request above.
            </Callout>
          )}
          <Callout tone="info" icon={EyeOff} title="Privacy">
            {c.privacy === "shielded"
              ? "This was requested as a shielded payment. Amount and addresses aren't visible on the public chain; your receiving wallet verified it with its own viewing capability."
              : "This was a transparent payment — its amount and addresses are publicly visible on the Zcash chain."}{" "}
            No public explorer link is shown{c.deposit?.publicTxid ? "" : " because there is no verified public transaction id for this payment"}.
          </Callout>
        </div>

        <aside className="space-y-6 xl:col-span-4">
          <Panel>
            <PanelHeader title="Details" />
            <PanelBody className="space-y-4">
              <DataList
                items={[
                  { label: "Source", value: modeLabel(c.mode) },
                  ...(link ? [{ label: "Payment link", value: <Link className="link" href={`/app/links/${link.id}`}>{link.title}</Link> }] : []),
                  { label: "Created", value: formatDateTime(c.createdAt) },
                  { label: "Invoice (INR)", value: formatInr(c.quote.inrMinor) },
                  { label: "Customer total (incl. fees)", value: formatInr(c.quote.totalInrMinor) },
                  { label: "ZEC quoted", value: <span className="font-mono">{formatZec(c.quote.zecZat, { fixed: true })}</span> },
                  { label: "ZEC received", value: c.deposit ? <span className="font-mono">{formatZec(c.deposit.zecZat, { fixed: true })}</span> : "—" },
                  { label: "Confirmations", value: c.deposit ? `${c.deposit.confirmations} / ${c.deposit.requiredConfirmations}` : "—" },
                  { label: "Privacy", value: <PrivacyBadge privacy={c.privacy} /> },
                  { label: "Quote source", value: c.quote.source === "demo" ? "Aggregated Oracle Feed" : c.quote.provider },
                  {
                    label: "Merchant credit",
                    value: root ? <MetaBadge meta={CREDIT_META[root.status]} /> : "None issued",
                    hint: root?.unlockAt ? `Unlocks ${formatDate(root.unlockAt)}` : undefined,
                  },
                  ...(c.customerNote ? [{ label: "Customer note", value: c.customerNote }] : []),
                ]}
              />
              <div className="space-y-2">
                <p className="text-label text-foreground-secondary">Checkout id</p>
                <CopyableValue value={c.id} label="Checkout id" />
                <p className="text-label text-foreground-secondary">Receiving address</p>
                <CopyableValue value={c.receivingAddress} label="Address" />
                {c.deposit && (
                  <>
                    <p className="text-label text-foreground-secondary">Deposit output ref</p>
                    <CopyableValue value={c.deposit.outputRef} label="Output ref" />
                  </>
                )}
              </div>
            </PanelBody>
          </Panel>
        </aside>
      </div>
    </>
  );
}
