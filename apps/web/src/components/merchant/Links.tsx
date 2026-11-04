"use client";

import React, { useMemo, useState } from "react";
import { Link2, Plus } from "lucide-react";
import { useNow, useZeb } from "@/providers/ZebProvider";
import { useMerchantData, effectiveLinkStatus, linkUses } from "@/lib/selectors";
import { formatInr } from "@/lib/money";
import { formatDate } from "@/lib/format";
import type { PaymentLink, PaymentLinkStatus } from "@/types/domain";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Blocks";
import { SearchInput, Segmented, Select } from "@/components/ui/Field";
import { Panel } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/Table";
import { LINK_META, MetaBadge } from "@/components/ui/StatusBadge";

export function linkAmountLabel(l: PaymentLink) {
  return l.amountMode === "fixed" ? formatInr(l.fixedInrMinor ?? 0) : `${formatInr(l.minInrMinor ?? 0, { whole: true })} – ${formatInr(l.maxInrMinor ?? 0, { whole: true })}`;
}

type Filter = "all" | PaymentLinkStatus;
type Sort = "newest" | "oldest" | "payments";

export function LinksList() {
  const { state } = useZeb();
  const now = useNow(10_000) ?? state.seededAt;
  const { links } = useMerchantData();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("newest");

  const rows = useMemo(() => {
    const enriched = links.map((l) => ({ link: l, status: effectiveLinkStatus(state, l, now), uses: linkUses(state, l) }));
    const needle = q.trim().toLowerCase();
    return enriched
      .filter((r) => filter === "all" || r.status === filter)
      .filter((r) => !needle || [r.link.title, r.link.slug, r.link.reference].some((x) => x.toLowerCase().includes(needle)))
      .sort((a, b) => (sort === "newest" ? b.link.createdAt - a.link.createdAt : sort === "oldest" ? a.link.createdAt - b.link.createdAt : b.uses - a.uses));
  }, [links, state, now, q, filter, sort]);

  const count = (s: PaymentLinkStatus) => links.filter((l) => effectiveLinkStatus(state, l, now) === s).length;

  return (
    <>
      <MerchantPageHeader
        title="Get paid from anywhere"
        description="Shareable payment links with a fixed price or a customer-chosen amount. Each visit gets its own quote and receiving address."
        actions={
          <ButtonLink href="/app/links/new">
            <Plus aria-hidden className="h-4 w-4" /> Create link
          </ButtonLink>
        }
      />
      <Panel>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <Segmented<Filter>
            label="Filter by status"
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: links.length },
              { value: "active", label: "Active", count: count("active") },
              { value: "exhausted", label: "Exhausted", count: count("exhausted") },
              { value: "expired", label: "Expired", count: count("expired") },
              { value: "revoked", label: "Revoked", count: count("revoked") },
            ]}
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <SearchInput label="Search links" placeholder="Search title, slug or reference" value={q} onChange={(e) => setQ(e.target.value)} wrapperClassName="sm:w-72" />
            <Select aria-label="Sort links" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="sm:w-44">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="payments">Most payments</option>
            </Select>
          </div>
        </div>
        <DataTable
          rows={rows}
          rowKey={(r) => r.link.id}
          onRowHref={(r) => `/app/links/${r.link.id}`}
          caption="Payment links"
          mobileTitle={(r) => r.link.title}
          columns={[
            { key: "title", header: "Title", hideOnMobile: true, cell: (r) => <span className="font-medium">{r.link.title}</span> },
            { key: "amount", header: "Amount", cell: (r) => <span className="num">{r.link.amountMode === "fixed" ? linkAmountLabel(r.link) : `Variable ${linkAmountLabel(r.link)}`}</span> },
            { key: "paid", header: "Successful payments", align: "right", cell: (r) => <span className="num">{r.uses}</span> },
            { key: "uses", header: "Use limit", cell: (r) => <span className="num text-foreground-secondary">{r.link.reusable ? (r.link.useLimit ?? "Unlimited") : "One-time"}</span> },
            { key: "status", header: "Status", cell: (r) => <MetaBadge meta={LINK_META[r.status]} /> },
            { key: "created", header: "Created", cell: (r) => <span className="num text-label text-foreground-secondary">{formatDate(r.link.createdAt)}</span> },
          ]}
          empty={
            <EmptyState
              icon={Link2}
              title={links.length ? "No links match" : "No payment links yet"}
              description={links.length ? "Try a different search or filter." : "Create a link for a fixed price or let customers choose an amount within limits."}
              action={
                !links.length && (
                  <ButtonLink href="/app/links/new" size="sm">
                    Create link
                  </ButtonLink>
                )
              }
            />
          }
        />
      </Panel>
    </>
  );
}
