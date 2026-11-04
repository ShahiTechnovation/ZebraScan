"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useZeb } from "@/providers/ZebProvider";
import { api, errorMessage } from "@/services/live/api";
import { Button } from "@/components/ui/Button";
import { COPY } from "@/config/mode";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md items-center px-4 py-12">
      <div className="panel w-full p-6 sm:p-8">
        <h1 className="font-display text-[24px] font-semibold tracking-[-0.02em]">{title}</h1>
        <div className="mt-4 space-y-3 text-[14px] text-foreground-secondary">{children}</div>
      </div>
    </div>
  );
}

export function VerifyEmail() {
  const token = useSearchParams().get("token") ?? "";
  const { live } = useZeb();
  const [state, setState] = useState<"idle" | "ok" | "error">("idle");
  const [msg, setMsg] = useState("");
  const done = useRef(false);
  useEffect(() => {
    if (!live || !token || done.current) return;
    done.current = true;
    api
      .call("verifyEmail", { body: { token } })
      .then(async () => {
        setState("ok");
        await live.refreshSession().catch(() => undefined);
      })
      .catch((e) => {
        setState("error");
        setMsg(errorMessage(e));
      });
  }, [live, token]);
  if (!live) return <Shell title="Verify email">{COPY.notConnected}</Shell>;
  return (
    <Shell title="Verify email">
      {!token && <p>This link is missing its token.</p>}
      {token && state === "idle" && <p>Verifying…</p>}
      {state === "ok" && (
        <>
          <p>Your email is verified.</p>
          <Link className="link" href="/app">
            Go to your dashboard
          </Link>
        </>
      )}
      {state === "error" && <p role="alert">{msg}</p>}
    </Shell>
  );
}

export function ResetPassword() {
  const token = useSearchParams().get("token") ?? "";
  const { live } = useZeb();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"idle" | "ok">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!live) return <Shell title="Reset password">{COPY.notConnected}</Shell>;
  if (state === "ok")
    return (
      <Shell title="Password updated">
        <p>Your password was changed and all sessions were signed out.</p>
        <Link className="link" href="/login">
          Sign in
        </Link>
      </Shell>
    );
  return (
    <Shell title="Choose a new password">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.call("resetPassword", { body: { token, password: pw } });
            setState("ok");
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="new-pw" className="text-label font-medium">
          New password
        </label>
        <input id="new-pw" type="password" autoComplete="new-password" minLength={12} className="input w-full" value={pw} onChange={(e) => setPw(e.target.value)} />
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <Button type="submit" isLoading={busy} disabled={!token || pw.length < 12} className="w-full">
          Update password
        </Button>
      </form>
    </Shell>
  );
}
