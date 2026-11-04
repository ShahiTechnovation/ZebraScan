"use client";

import React, { useEffect, useState } from "react";
import { useLiveResource, useZeb } from "@/providers/ZebProvider";
import { Container } from "@/components/layout/Container";
import { PageSkeleton } from "@/components/ui/Blocks";
import { ReceiptActions, ReceiptDocument } from "@/components/payments/ReceiptDocument";
import { NotFoundPanel } from "./NotFoundPanel";

export function PublicReceipt({ id }: { id: string }) {
  const { ready, state } = useZeb();
  const res = useLiveResource("receipt", id);
  const [url, setUrl] = useState("");
  useEffect(() => setUrl(window.location.href), []);
  if (!ready || res.loading) return <Container className="py-10"><PageSkeleton /></Container>;
  const r = state.receipts.find((x) => x.id === id);
  if (!r) return <NotFoundPanel title="Receipt not found" body="This receipt record was not found or has expired." href="/" cta="Go to Zeb Scan home" />;
  return (
    <Container className="max-w-2xl space-y-4 py-8 sm:py-12">
      <ReceiptActions receipt={r} state={state} shareUrl={url} />
      <ReceiptDocument receipt={r} state={state} />
    </Container>
  );
}
