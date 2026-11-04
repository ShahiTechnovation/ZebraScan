"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useZeb } from "@/providers/ZebProvider";
import { api, errorMessage, setCsrf } from "@/services/live/api";
import { Button } from "@/components/ui/Button";

/** Real email + password sign-in / registration against the Zeb Scan API (connected mode). */
export function ConnectedAuth({ next }: { next: string }) {
  const router = useRouter();
  const { live } = useZeb();
  const [tab, setTab] = useState<"signin" | "register" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const emailDelivery = live?.config?.auth.emailDelivery ?? false;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (tab === "forgot") {
        await api.call("forgotPassword", { body: { email } });
        setInfo(
          emailDelivery
            ? "If an account exists for that email, a reset link is on its way. It expires in 30 minutes."
            : "Request recorded, but email delivery is not configured on this server, so no message will arrive. Contact support.",
        );
        return;
      }
      const r = tab === "signin" ? await api.call("login", { body: { email, password } }) : await api.call("register", { body: { email, password } });
      setCsrf(r.csrfToken);
      await live?.refreshSession();
      router.push(live?.merchant ? next : "/onboarding");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Account" className="grid grid-cols-2 rounded-input bg-surface-2 p-1 text-[13px]">
        {(["signin", "register"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              setError(null);
              setInfo(null);
            }}
            className={`rounded-input px-3 py-1.5 font-medium ${tab === t ? "bg-surface-1 text-foreground shadow-sm" : "text-foreground-secondary"}`}
          >
            {t === "signin" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <label htmlFor="auth-email" className="text-label font-medium text-foreground-secondary">
            Email
          </label>
          <input id="auth-email" type="email" autoComplete="email" required className="input mt-1 w-full" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {tab !== "forgot" && (
          <div>
            <label htmlFor="auth-pw" className="text-label font-medium text-foreground-secondary">
              Password
            </label>
            <input
              id="auth-pw"
              type="password"
              autoComplete={tab === "register" ? "new-password" : "current-password"}
              required
              minLength={tab === "register" ? 12 : 1}
              className="input mt-1 w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={tab === "register" ? "pw-hint" : undefined}
            />
            {tab === "register" && (
              <p id="pw-hint" className="mt-1 text-micro text-foreground-muted">
                At least 12 characters. A passphrase works well.
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-input border border-danger/40 bg-danger/[0.06] px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}
        {info && (
          <p role="status" className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[13px] text-foreground-secondary">
            {info}
          </p>
        )}
        <Button type="submit" className="w-full" isLoading={busy} disabled={!email || (tab !== "forgot" && !password)}>
          {tab === "signin" ? "Sign in" : tab === "register" ? "Create account" : "Send reset link"}
        </Button>
      </form>
      <div className="flex justify-between text-label">
        {tab !== "forgot" ? (
          <button type="button" className="link" onClick={() => setTab("forgot")}>
            Forgot password?
          </button>
        ) : (
          <button type="button" className="link" onClick={() => setTab("signin")}>
            Back to sign in
          </button>
        )}
      </div>
      {tab === "register" && !emailDelivery && (
        <p className="text-micro leading-relaxed text-foreground-muted">
          Email delivery is not configured on this server. You can create an account, but email verification (required before adding a payout destination) cannot be completed until it is.
        </p>
      )}
    </div>
  );
}
