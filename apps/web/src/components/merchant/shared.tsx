"use client";

import React from "react";
import type { CheckoutIntent, DemoState, MerchantCredit } from "@/types/domain";
import { CREDIT_META, DEPOSIT_META, MetaBadge } from "@/components/ui/StatusBadge";
import { modeLabel } from "@/services/demo/engine";
import { Inr, Zec } from "@/components/ui/Money";
import { formatDate, formatDateTime } from "@/lib/format";
import type { Column } from "@/components/ui/Table";
import { checkoutTitle } from "@/lib/selectors";

export function CheckoutStatus({ c, credit, short }: { c: CheckoutIntent; credit?: MerchantCredit; short?: boolean }) {
  if (c.depositStatus === "accepted" && credit)
    return <MetaBadge meta={CREDIT_META[credit.status]} label={short ? CREDIT_META[credit.status].label : `Credit ${CREDIT_META[credit.status].label.toLowerCase()}`} />;
  return <MetaBadge meta={DEPOSIT_META[c.depositStatus]} />;
}

export function txColumns(state: DemoState, opts: { compact?: boolean } = {}): Column<CheckoutIntent>[] {
  const creditOf = (c: CheckoutIntent) => state.credits.find((cr) => cr.checkoutId === c.id && !cr.parentCreditId);
  if (opts.compact)
    return [
      {
        key: "kind",
        header: "Kind",
        hideOnMobile: true,
        cell: (c) => (
          <span className="flex flex-col whitespace-nowrap">
            <span className="font-medium text-foreground">{modeLabel(c.mode)}</span>
            <span className="font-mono text-micro text-foreground-muted">{c.id}</span>
          </span>
        ),
      },
      { key: "inr", header: "INR", align: "right", cell: (c) => <Inr minor={c.quote.inrMinor} className="whitespace-nowrap font-medium" /> },
      { key: "zec", header: "ZEC", align: "right", cell: (c) => <Zec zat={c.deposit?.zecZat ?? c.quote.zecZat} unit={false} className="text-label text-foreground-secondary" /> },
      { key: "date", header: "Date", cell: (c) => <span className="num whitespace-nowrap text-label text-foreground-secondary">{formatDate(c.createdAt)}</span> },
      { key: "state", header: "State", className: "whitespace-nowrap", cell: (c) => <CheckoutStatus c={c} credit={creditOf(c)} short /> },
    ];
  return [
    {
      key: "title",
      header: "Payment",
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-foreground">{checkoutTitle(state, c)}</span>
          <span className="font-mono text-micro text-foreground-muted">{c.id}</span>
        </span>
      ),
      hideOnMobile: true,
    },
    { key: "kind", header: "Source", className: "whitespace-nowrap", cell: (c) => <span className="text-foreground-secondary">{modeLabel(c.mode)}</span> },
    { key: "inr", header: "INR", align: "right", cell: (c) => <Inr minor={c.quote.inrMinor} className="font-medium" /> },
    { key: "zec", header: "ZEC", align: "right", cell: (c) => <Zec zat={c.deposit?.zecZat ?? c.quote.zecZat} unit={false} className="text-label text-foreground-secondary" /> },
    { key: "date", header: "Date", cell: (c) => <span className="num whitespace-nowrap text-label text-foreground-secondary">{formatDateTime(c.createdAt)}</span> },
    { key: "state", header: "Status", className: "whitespace-nowrap", cell: (c) => <CheckoutStatus c={c} credit={creditOf(c)} /> },
  ];
}
