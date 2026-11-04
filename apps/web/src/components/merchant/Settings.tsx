"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { LogOut, RotateCcw, Upload } from "lucide-react";
import { useZeb } from "@/providers/ZebProvider";
import { useAction } from "@/lib/useAction";
import { validateVpa } from "@/lib/upi";
import { useToast } from "@/providers/ToastProvider";
import { COPY } from "@/config/mode";
import type { Merchant } from "@/types/domain";
import { MerchantPageHeader } from "@/components/layout/AppShell";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Blocks";
import { FormField, Input, Segmented, Select, Switch } from "@/components/ui/Field";
import { ConfirmDialog } from "@/components/ui/Modal";
import { Panel, PanelBody, PanelFooter, PanelHeader } from "@/components/ui/Panel";

type Tab = "business" | "payout" | "privacy" | "preferences" | "demo";
const TABS: Tab[] = ["business", "payout", "privacy", "preferences", "demo"];
const CATEGORIES = ["Food & beverage", "Retail", "Groceries", "Services", "Education", "Health & wellness", "Travel & transport", "Events", "Other"];

export function Settings() {
  const params = useSearchParams();
  const router = useRouter();
  const initial = (params.get("tab") as Tab) ?? "business";
  const [tab, setTab] = useState<Tab>(TABS.includes(initial) ? initial : "business");
  const { merchant } = useZeb();
  if (!merchant) return null;
  return (
    <>
      <MerchantPageHeader title="Settings" description="Your shop profile, payout destination, privacy defaults and demo data." />
      <Segmented<Tab>
        label="Settings sections"
        role="tabs"
        className="mb-6"
        value={tab}
        onChange={(t) => {
          setTab(t);
          router.replace(`/app/settings?tab=${t}`, { scroll: false });
        }}
        options={[
          { value: "business", label: "Business" },
          { value: "payout", label: "Payout UPI" },
          { value: "privacy", label: "Privacy" },
          { value: "preferences", label: "Preferences" },
          { value: "demo", label: "Demo & data" },
        ]}
      />
      <div role="tabpanel" className="max-w-2xl">
        {tab === "business" && <BusinessTab key={merchant.id} merchant={merchant} />}
        {tab === "payout" && <PayoutTab key={merchant.id} merchant={merchant} />}
        {tab === "privacy" && <PrefsTab key={merchant.id} merchant={merchant} kind="privacy" />}
        {tab === "preferences" && <PrefsTab key={merchant.id} merchant={merchant} kind="preferences" />}
        {tab === "demo" && <DemoTab />}
      </div>
    </>
  );
}

function BusinessTab({ merchant }: { merchant: Merchant }) {
  const { services } = useZeb();
  const { run, busy } = useAction();
  const [name, setName] = useState(merchant.businessName);
  const [category, setCategory] = useState(merchant.category);
  const [logo, setLogo] = useState(merchant.logoDataUrl);
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const nameErr = name.trim().length < 2 || name.trim().length > 60 ? "Business name must be 2–60 characters." : null;
  return (
    <Panel>
      <PanelHeader title="Business profile" description="Shown on your checkout pages, counter QR and receipts." />
      <PanelBody className="space-y-4">
        <FormField label="Business name" error={nameErr}>
          {(p) => <Input {...p} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />}
        </FormField>
        <FormField label="Merchant handle" hint="Handles can't be changed in the demo. Your counter link can be regenerated from Counter QR.">
          {(p) => <Input {...p} value={merchant.handle} disabled className="font-mono" />}
        </FormField>
        <FormField label="Category">
          {(p) => (
            <Select {...p} value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          )}
        </FormField>
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border border-border bg-surface-2 font-semibold">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {logo ? <img src={logo} alt="Logo preview" className="h-full w-full object-cover" /> : name.slice(0, 1).toUpperCase()}
          </span>
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-border px-4 text-[13px] hover:border-border-strong">
            <Upload aria-hidden className="h-4 w-4" /> Change logo
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                setLogoErr(null);
                if (!f) return;
                if (f.size > 300 * 1024) return setLogoErr("Logo must be under 300 KB.");
                const r = new FileReader();
                r.onload = () => setLogo(String(r.result));
                r.readAsDataURL(f);
              }}
            />
          </label>
          {logo && (
            <Button variant="ghost" size="sm" onClick={() => setLogo(undefined)}>
              Remove logo
            </Button>
          )}
          {logoErr && <p className="w-full text-label text-danger">{logoErr}</p>}
        </div>
      </PanelBody>
      <PanelFooter className="flex justify-end">
        <Button
          disabled={Boolean(nameErr) || !services}
          isLoading={busy}
          onClick={() => run(() => services!.merchant.updateMerchant(merchant.id, { businessName: name.trim(), category, logoDataUrl: logo }), "Business profile saved")}
        >
          Save changes
        </Button>
      </PanelFooter>
    </Panel>
  );
}

function PayoutTab({ merchant }: { merchant: Merchant }) {
  const { services, live } = useZeb();
  const { run, busy } = useAction();
  const [upi, setUpi] = useState(merchant.payoutUpi);
  const [ben, setBen] = useState(merchant.beneficiaryName);
  const upiErr = validateVpa(upi);
  const benErr = ben.trim().length < 2 ? "Enter a beneficiary display name." : null;
  return (
    <Panel>
      <PanelHeader title="Payout UPI" description="Where withdrawals are sent by the payout provider." />
      <PanelBody className="space-y-4">
        <FormField label="Payout UPI ID" error={upi ? upiErr : "Enter a UPI ID."}>
          {(p) => <Input {...p} value={upi} onChange={(e) => setUpi(e.target.value.trim())} className="font-mono" autoCapitalize="none" spellCheck={false} />}
        </FormField>
        <FormField label="Beneficiary display name" error={benErr}>
          {(p) => <Input {...p} value={ben} maxLength={60} onChange={(e) => setBen(e.target.value)} />}
        </FormField>
        <Callout tone="info">
          {live
            ? "New payout UPI IDs are encrypted, reviewed and held for a security cooling-off period before use. You will need to confirm your password. In-progress withdrawals keep the UPI ID they were requested with."
            : "No bank or UPI validation happens in this build — the format is checked, nothing more. Changes apply to new withdrawals only; in-progress withdrawals keep the UPI ID they were requested with."}
        </Callout>
      </PanelBody>
      <PanelFooter className="flex justify-end">
        <Button
          disabled={Boolean(upiErr) || Boolean(benErr) || !services}
          isLoading={busy}
          onClick={() => run(() => services!.merchant.updateMerchant(merchant.id, { payoutUpi: upi, beneficiaryName: ben.trim() }), "Payout destination saved")}
        >
          Save payout destination
        </Button>
      </PanelFooter>
    </Panel>
  );
}

function PrefsTab({ merchant, kind }: { merchant: Merchant; kind: "privacy" | "preferences" }) {
  const { services } = useZeb();
  const { run } = useAction();
  const p = merchant.preferences;
  const save = (patch: Partial<Merchant["preferences"]>) => services && run(() => services.merchant.updateMerchant(merchant.id, { preferences: { ...p, ...patch } }), "Preference saved");
  if (kind === "privacy")
    return (
      <Panel>
        <PanelHeader title="Privacy defaults" description={COPY.privacyHelper} />
        <PanelBody className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-label font-medium text-foreground-secondary">Default privacy for new checkouts</p>
            <Segmented
              label="Default privacy"
              value={p.defaultPrivacy}
              onChange={(v) => save({ defaultPrivacy: v, ...(v === "transparent" ? { allowTransparent: true } : {}) })}
              options={[
                { value: "shielded", label: "Shielded (recommended)" },
                { value: "transparent", label: "Transparent" },
              ]}
            />
          </div>
          <Switch
            checked={p.allowTransparent}
            onChange={(v) => save({ allowTransparent: v, ...(v ? {} : { defaultPrivacy: "shielded" }) })}
            label="Accept transparent ZEC"
            description="Customers whose wallet can't send shielded ZEC can still pay, with a public-visibility warning."
          />
          <Switch checked={p.showZecOnReceipts} onChange={(v) => save({ showZecOnReceipts: v })} label="Show ZEC amount on receipts" description="Receipts never show shielded transaction details." />
        </PanelBody>
      </Panel>
    );
  return (
    <Panel>
      <PanelHeader title="Notifications" description="In-app only in this build — no emails or SMS are sent." />
      <PanelBody className="space-y-4">
        <Switch checked={p.notifyOnCredit} onChange={(v) => save({ notifyOnCredit: v })} label="When a payment is verified" />
        <Switch checked={p.notifyOnWithdrawal} onChange={(v) => save({ notifyOnWithdrawal: v })} label="When a withdrawal changes status" />
        <p className="text-label text-foreground-secondary">
          Need help with statuses? <Link href="/app/help" className="link">Open the help center</Link>.
        </p>
      </PanelBody>
    </Panel>
  );
}

function DemoTab() {
  const { demo, isDemo } = useZeb();
  const router = useRouter();
  const toast = useToast();
  const [resetOpen, setResetOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  if (!isDemo || !demo)
    return (
      <Panel>
        <PanelBody>
          <p className="text-[14px] text-foreground-secondary">{COPY.notConnected}</p>
        </PanelBody>
      </Panel>
    );
  return (
    <div className="space-y-6">
      <Panel>
        <PanelHeader title="Demo data" description="Everything is stored in this browser's local storage." />
        <PanelBody className="space-y-3 text-[13px] text-foreground-secondary">
          <p>{COPY.simulation}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" onClick={() => setResetOpen(true)} disabled={!hydrated}>
              <RotateCcw aria-hidden className="h-4 w-4" /> Reset demo data
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                demo.signOut();
                router.push("/login");
              }}
            >
              <LogOut aria-hidden className="h-4 w-4" /> Sign out of demo
            </Button>
          </div>
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader title="Treasury ops view" description="A demo-only admin overview. It isn't part of merchant navigation and has no transfer controls." />
        <PanelBody>
          <ButtonLink href="/app/ops" variant="secondary">
            Open demo ops view
          </ButtonLink>
        </PanelBody>
      </Panel>
      <ConfirmDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onConfirm={() => {
          demo.reset();
          toast("Demo data reset to the sample seed");
          router.push("/login");
        }}
        title="Reset all demo data?"
        description="This deletes every demo merchant, link, checkout, credit and withdrawal in this browser and restores the sample seed. It can't be undone."
        confirmLabel="Reset demo data"
        confirmVariant="danger"
      />
    </div>
  );
}
