/**
 * Noir Wallet connect / sign-in / pay against a stub shaped like the provider the real extension
 * injects. Noir Wallet 1.0.40's MAIN-world `inject-provider` script (as consumed by
 * @noir-wallet/sdk 0.1.9) does `Object.defineProperty(window, "noirwallet", { value: frozen
 * { isNoirWallet: true, version, zcash } })` at document_start, then dispatches
 * `noirwallet#initialized`. `zcash.request({ method, params })` resolves the result or rejects with
 * `Error(message)`. The real extension is NOT exercised here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CheckoutIntent } from "@/types/domain";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/login",
}));

type RequestArgs = { method: string; params?: unknown[] };
type Handlers = Record<string, (params: unknown[] | undefined) => unknown>;

const TESTNET = { transparent: "tmQhXhY2aM5gYPxr6hSRDsDm5b1k3UjCqzH", shielded: "utest1qq9w0r7d2k5lzgq8ys7lq3d0hx0n2v7m9c4e6f8a0b2c4d6e8f0" };
const MAINNET = { transparent: "t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU", shielded: "u1qq9w0r7d2k5lzgq8ys7lq3d0hx0n2v7m9c4e6f8a0b2c4d6e8f0" };
const SIGNATURE = { signature: `1f${"ab".repeat(64)}`, pubkey: `02${"11".repeat(32)}`, address: "tmDerivedIdentity11111111111111111", signingMode: "derived" as const };

function installNoir(handlers: Handlers) {
  const calls: RequestArgs[] = [];
  const zcash = Object.freeze({
    async request(args: RequestArgs) {
      calls.push(args);
      const handler = handlers[args.method];
      if (!handler) throw new Error("Invalid or unsupported method");
      return handler(args.params);
    },
    on() {},
    removeListener() {},
    async disconnect() {},
  });
  Object.defineProperty(window, "noirwallet", {
    value: Object.freeze({ isNoirWallet: true, version: "1.0.40", zcash }),
    writable: false,
    enumerable: true,
    configurable: true, // the extension uses false; tests must be able to remove it again
  });
  window.dispatchEvent(new Event("noirwallet#initialized"));
  return calls;
}

function removeNoir() {
  delete (window as unknown as { noirwallet?: unknown }).noirwallet;
}

async function mockApi(responses: Record<string, unknown>) {
  const { api } = await import("@/services/live/api");
  const seen: { op: string; body: unknown }[] = [];
  vi.spyOn(api, "call").mockImplementation((async (op: string, args?: { body?: unknown }) => {
    seen.push({ op, body: args?.body });
    if (op in responses) return responses[op];
    throw new Error(`unexpected API call ${op}`);
  }) as unknown as typeof api.call);
  return seen;
}

const challenge = (message: string) => ({ challengeId: "chl_test_0001", message, network: "zcash-testnet", expiresAt: new Date(Date.now() + 300_000).toISOString() });

afterEach(() => {
  cleanup();
  removeNoir();
  vi.restoreAllMocks();
  vi.doUnmock("@/providers/ZebProvider");
  vi.resetModules();
  router.push.mockClear();
});

describe("Noir provider detection", () => {
  it("finds the provider the extension defines at document_start, and agrees with the vendor SDK", async () => {
    installNoir({});
    const { detectNoir, getNoirProvider, noirVersion } = await import("@/services/live/noir");
    const sdk = await import("@noir-wallet/sdk");
    expect(getNoirProvider()).not.toBeNull();
    expect(noirVersion()).toBe("1.0.40");
    await expect(detectNoir(50)).resolves.toBe(true);
    expect(sdk.isNoirWalletInstalled()).toBe(true);
    await expect(sdk.detectProvider(50)).resolves.toBe(getNoirProvider());
  });

  it("waits for a late noirwallet#initialized instead of reporting 'not installed'", async () => {
    const { detectNoir } = await import("@/services/live/noir");
    const pending = detectNoir(3000);
    setTimeout(() => installNoir({}), 250);
    await expect(pending).resolves.toBe(true);
  });

  it("reports not installed once the timeout passes without a provider", async () => {
    const { detectNoir } = await import("@/services/live/noir");
    await expect(detectNoir(200)).resolves.toBe(false);
  });

  it("explains origins the extension never injects into (content scripts match only https://* and http://localhost/*)", async () => {
    const { noirOriginProblem } = await import("@/services/live/noir");
    expect(noirOriginProblem({ protocol: "http:", hostname: "127.0.0.1", port: "3001" })).toMatch(/open http:\/\/localhost:3001/);
    expect(noirOriginProblem({ protocol: "http:", hostname: "localhost", port: "3001" })).toBeNull();
    expect(noirOriginProblem({ protocol: "https:", hostname: "zebrascan.vercel.app", port: "" })).toBeNull();
  });
});

describe("connect / sign-in / pay use the SDK 0.1.9 request shapes", () => {
  it("connectNoir sends zcash_requestAccounts exactly like ZcashAPI.connect() and returns the account", async () => {
    const calls = installNoir({ zcash_requestAccounts: () => ({ ...TESTNET, accounts: [] }) });
    const { connectNoir } = await import("@/services/live/noir");
    await expect(connectNoir("testnet")).resolves.toEqual({ ...TESTNET, network: "testnet" });
    const sdk = await import("@noir-wallet/sdk");
    await sdk.getNoirWallet()?.zcash.connect();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ method: "zcash_requestAccounts" });
    expect(calls[1]).toEqual(calls[0]);
  });

  it("posts the wallet request synchronously, before anything is awaited", async () => {
    const calls = installNoir({ zcash_requestAccounts: () => TESTNET });
    const { connectNoir } = await import("@/services/live/noir");
    const pending = connectNoir("testnet");
    expect(calls.map((c) => c.method)).toEqual(["zcash_requestAccounts"]);
    await pending;
  });

  it("rejects a mainnet wallet on a testnet site with the fix", async () => {
    installNoir({ zcash_requestAccounts: () => MAINNET });
    const { connectNoir } = await import("@/services/live/noir");
    await expect(connectNoir("testnet")).rejects.toThrow(/Zcash mainnet.*\[Testnet\] Noir Wallet/);
  });

  it("surfaces the wallet's own rejection text", async () => {
    installNoir({
      zcash_requestAccounts: () => {
        throw new Error("User rejected the request");
      },
    });
    const { connectNoir } = await import("@/services/live/noir");
    await expect(connectNoir()).rejects.toThrow("Noir Wallet connection failed: User rejected the request.");
  });

  it("does not swallow non-Error rejections", async () => {
    installNoir({ zcash_requestAccounts: () => Promise.reject({ code: 4100, message: "Wallet is locked" }) });
    const { connectNoir, noirErrorMessage } = await import("@/services/live/noir");
    const err = await connectNoir().catch((e: unknown) => e);
    expect(noirErrorMessage(err)).toContain("Wallet is locked (code 4100)");
    expect(noirErrorMessage({ message: "raw object" })).toBe("raw object");
    expect(noirErrorMessage("plain string")).toBe("plain string");
  });

  it("says plainly when the extension is missing", async () => {
    const { connectNoir } = await import("@/services/live/noir");
    await expect(connectNoir()).rejects.toThrow(/not installed or not enabled/);
  });

  it("signInWithNoir: requestAccounts, server challenge, derived signMessage, server verify", async () => {
    const message = "Zeb Scan wants you to sign in\nDomain: localhost:3001";
    const calls = installNoir({ zcash_requestAccounts: () => TESTNET, zcash_signMessage: () => ({ ...SIGNATURE, originAddress: TESTNET.transparent }) });
    const seen = await mockApi({ walletChallenge: challenge(message), walletVerify: { userId: "usr_1", emailVerified: false, csrfToken: "csrf_1" } });
    const { signInWithNoir } = await import("@/services/live/noir");
    await expect(signInWithNoir("login", "testnet")).resolves.toEqual({ userId: "usr_1", emailVerified: false });
    expect(calls).toEqual([{ method: "zcash_requestAccounts" }, { method: "zcash_signMessage", params: [message, { signingMode: "derived" }] }]);
    expect(seen).toEqual([
      { op: "walletChallenge", body: { action: "login" } },
      { op: "walletVerify", body: { challengeId: "chl_test_0001", signature: SIGNATURE.signature, pubkey: SIGNATURE.pubkey, address: SIGNATURE.address, signingMode: "derived" } },
    ]);
    const sdk = await import("@noir-wallet/sdk");
    await sdk.getNoirWallet()?.zcash.signMessage(message, { signingMode: "derived" });
    expect(calls[2]).toEqual(calls[1]);
  });

  it("payWithNoir sends the exact invoice amount and memo as a shielded transfer", async () => {
    const to = "utest1invoiceaddress0000000000000000000000000000000";
    const calls = installNoir({ zcash_requestAccounts: () => TESTNET, zcash_sendTransaction: () => "a".repeat(64) });
    const { payWithNoir } = await import("@/services/live/noir");
    await expect(payWithNoir({ to, zat: "1234567", memo: "ZEB-7Q2K", network: "testnet" })).resolves.toBe("a".repeat(64));
    expect(calls).toEqual([
      { method: "zcash_requestAccounts" },
      { method: "zcash_sendTransaction", params: [{ to, amount: "0.01234567", memo: "ZEB-7Q2K", fundingSource: "shielded" }] },
    ]);
    const sdk = await import("@noir-wallet/sdk");
    await sdk.getNoirWallet()?.zcash.sendTransaction({ to, amount: "0.01234567", memo: "ZEB-7Q2K", fundingSource: "shielded" });
    expect(calls[2]).toEqual(calls[1]);
  });

  it("payWithNoir refuses before sending when the wallet is on the other network", async () => {
    const calls = installNoir({ zcash_requestAccounts: () => MAINNET, zcash_sendTransaction: () => "tx" });
    const { payWithNoir } = await import("@/services/live/noir");
    await expect(payWithNoir({ to: "utest1invoiceaddress0000000000000000000000000000000", zat: "100000", memo: null, network: "testnet" })).rejects.toThrow(/\[Testnet\] Noir Wallet/);
    expect(calls.map((c) => c.method)).toEqual(["zcash_requestAccounts"]);
  });
});

describe("Connect modal (real component)", () => {
  async function renderDemoModal() {
    const { ZebProvider } = await import("@/providers/ZebProvider");
    const { ConnectWalletModal } = await import("@/components/screens/ConnectWallet");
    render(
      <ZebProvider>
        <ConnectWalletModal open onClose={() => undefined} />
      </ZebProvider>,
    );
  }

  it("build without an API: the click posts zcash_requestAccounts synchronously and shows the account", async () => {
    const calls = installNoir({ zcash_requestAccounts: () => TESTNET });
    await renderDemoModal();
    fireEvent.click(await screen.findByRole("button", { name: /Connect Noir Wallet/ }));
    expect(calls).toEqual([{ method: "zcash_requestAccounts" }]); // still inside the click
    expect(await screen.findByText(/Noir Wallet connected · Zcash testnet/)).toBeTruthy();
    expect(screen.getByText(/^utest1/)).toBeTruthy();
  });

  it("shows the wallet's real error when the request is rejected", async () => {
    installNoir({
      zcash_requestAccounts: () => {
        throw new Error("User rejected the request");
      },
    });
    await renderDemoModal();
    fireEvent.click(await screen.findByRole("button", { name: /Connect Noir Wallet/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("User rejected the request");
  });

  it("without the extension it says so and offers a reload", async () => {
    await renderDemoModal();
    expect(await screen.findByText(/Install it to authenticate/, undefined, { timeout: 4500 })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reload this page/ })).toBeTruthy();
  }, 10_000);

  async function renderConnectedModal(onClose = vi.fn()) {
    const refreshSession = vi.fn(async () => undefined);
    const live = { config: { wallet: { noirNetwork: "zcash-testnet", payWithNoir: true }, auth: { emailDelivery: false } }, error: null, merchant: null, refreshSession };
    vi.doMock("@/providers/ZebProvider", () => ({ useZeb: () => ({ live }) }));
    const { ConnectWalletModal } = await import("@/components/screens/ConnectWallet");
    render(<ConnectWalletModal open onClose={onClose} />);
    return { refreshSession, onClose };
  }

  it("connected build: Connect & Sign In runs requestAccounts, challenge, signature and verify", async () => {
    const message = "Zeb Scan wants you to sign in";
    const calls = installNoir({ zcash_requestAccounts: () => TESTNET, zcash_signMessage: () => SIGNATURE });
    const seen = await mockApi({ walletChallenge: challenge(message), walletVerify: { userId: "usr_2", emailVerified: false, csrfToken: "csrf_2" } });
    const { refreshSession, onClose } = await renderConnectedModal();
    fireEvent.click(await screen.findByRole("button", { name: /Connect & Sign In/ }));
    expect(calls.map((c) => c.method)).toEqual(["zcash_requestAccounts"]); // still inside the click
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/onboarding"));
    expect(calls.map((c) => c.method)).toEqual(["zcash_requestAccounts", "zcash_signMessage"]);
    expect(seen.map((s) => s.op)).toEqual(["walletChallenge", "walletVerify"]);
    expect(refreshSession).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("connected build: a mainnet wallet is told to switch builds instead of failing on the server", async () => {
    installNoir({ zcash_requestAccounts: () => MAINNET, zcash_signMessage: () => SIGNATURE });
    const seen = await mockApi({});
    await renderConnectedModal();
    fireEvent.click(await screen.findByRole("button", { name: /Connect & Sign In/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Zcash mainnet.*\[Testnet\] Noir Wallet/);
    expect(seen).toEqual([]);
  });

  it("connected build before the API config loads: no guessed network, the challenge's network decides", async () => {
    const message = "Zeb Scan wants you to sign in";
    const mainSig = { ...SIGNATURE, address: "t1DerivedIdentity11111111111111111" };
    const calls = installNoir({ zcash_requestAccounts: () => MAINNET, zcash_signMessage: () => mainSig });
    const seen = await mockApi({ walletChallenge: { ...challenge(message), network: "zcash-mainnet" }, walletVerify: { userId: "usr_3", emailVerified: false, csrfToken: "csrf_3" } });
    const live = { config: null, error: null, merchant: null, refreshSession: vi.fn(async () => undefined) };
    vi.doMock("@/providers/ZebProvider", () => ({ useZeb: () => ({ live }) }));
    const { ConnectWalletModal } = await import("@/components/screens/ConnectWallet");
    render(<ConnectWalletModal open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Connect & Sign In/ }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/onboarding"));
    expect(calls.map((c) => c.method)).toEqual(["zcash_requestAccounts", "zcash_signMessage"]);
    expect(seen.map((s) => s.op)).toEqual(["walletChallenge", "walletVerify"]);
  });

  it("connected build with the API unreachable: connect only, and it says the API is unreachable", async () => {
    installNoir({ zcash_requestAccounts: () => TESTNET });
    const live = { config: null, error: "Backend unreachable", merchant: null, refreshSession: vi.fn(async () => undefined) };
    vi.doMock("@/providers/ZebProvider", () => ({ useZeb: () => ({ live }) }));
    const { ConnectWalletModal } = await import("@/components/screens/ConnectWallet");
    render(<ConnectWalletModal open onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Connect Noir Wallet/ })).toBeTruthy();
    expect(screen.getByText(/Zeb Scan API, which is not reachable right now\./)).toBeTruthy();
  });
});

describe("errors carry a next step", () => {
  it("a stale content script (extension switched off/on after the page loaded) says to reload the page", async () => {
    installNoir({
      zcash_requestAccounts: () => {
        throw new Error("Extension context invalidated.");
      },
    });
    const { connectNoir } = await import("@/services/live/noir");
    await expect(connectNoir()).rejects.toThrow("Noir Wallet connection failed: Extension context invalidated. Noir Wallet was reloaded or switched after this page opened. Reload this page, then try again.");
  });
});

describe("Pay with Noir in the checkout (real component)", () => {
  const UTEST = "utest1invoiceaddress0000000000000000000000000000000";

  function checkout(over: Partial<CheckoutIntent>): CheckoutIntent {
    const now = Date.now();
    return {
      id: "chk_noir_0001",
      mode: "scan_pay",
      merchantId: null,
      linkId: null,
      createdAt: now,
      quote: {
        id: "q_noir_0001",
        createdAt: now,
        expiresAt: now + 600_000,
        source: "live",
        provider: "test",
        privacy: "shielded",
        inrMinor: 50_000,
        protocolFeeBps: 0,
        platformFeeBps: 0,
        protocolFeeInrMinor: 0,
        platformFeeInrMinor: 0,
        totalInrMinor: 50_000,
        inrPerUsdcMinor: 9_000,
        usdMicroPerZec: 45_000_000,
        usdcMicro: "5555556",
        zecZat: "1234567",
      },
      privacy: "shielded",
      receivingAddress: UTEST,
      qrPayload: `zcash:${UTEST}?amount=0.01234567&memo=WkVCLTdRMks`,
      depositStatus: "awaiting",
      deposit: null,
      recipient: null,
      p2pOrderId: null,
      customerNote: "",
      exceptionReason: null,
      events: [],
      simulated: false,
      ...over,
    };
  }

  async function renderCheckout(c: CheckoutIntent) {
    const { ZebProvider } = await import("@/providers/ZebProvider");
    const { ToastProvider } = await import("@/providers/ToastProvider");
    const { CheckoutPanel } = await import("@/components/payments/CheckoutPanel");
    render(
      <ZebProvider>
        <ToastProvider>
          <CheckoutPanel checkout={c} />
        </ToastProvider>
      </ZebProvider>,
    );
  }

  it("testnet checkout: the click posts zcash_requestAccounts synchronously, then sends the exact amount and memo", async () => {
    const calls = installNoir({ zcash_requestAccounts: () => TESTNET, zcash_sendTransaction: () => "b".repeat(64) });
    await renderCheckout(checkout({ network: "testnet", envLabel: "TEST", memo: "ZEB-7Q2K" }));
    fireEvent.click(await screen.findByRole("button", { name: /Pay with Noir Wallet/ }));
    expect(calls).toEqual([{ method: "zcash_requestAccounts" }]); // still inside the click
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ method: "zcash_sendTransaction", params: [{ to: UTEST, amount: "0.01234567", memo: "ZEB-7Q2K", fundingSource: "shielded" }] });
    expect(await screen.findByText(/Payment initiated in Noir Wallet/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never pays a mainnet address displayed on a demo/testnet checkout, even when a mainnet wallet answers", async () => {
    const calls = installNoir({ zcash_requestAccounts: () => MAINNET, zcash_sendTransaction: () => "c".repeat(64) });
    // Demo checkout: its non-payable placeholder address is displayed as a hard-coded mainnet u1 address.
    await renderCheckout(checkout({ receivingAddress: "zebscan-demo-address-chk_noir_0001-not-payable", qrPayload: "zebscan-demo://checkout/chk_noir_0001" }));
    // The demo shows the operator's real mainnet shielded address for deliberate QR payments, but never offers
    // a one-click wallet payment from a checkout that cannot confirm it or pay INR.
    await screen.findByText(/Real ZEC — Zcash mainnet/);
    expect(screen.queryByRole("button", { name: /Pay with Noir Wallet/ })).toBeNull();
    expect(calls).toEqual([]); // no wallet request at all
  });

  it("keeps the wallet's error on screen instead of only in a ~3 s toast", async () => {
    installNoir({ zcash_requestAccounts: () => MAINNET });
    await renderCheckout(checkout({ network: "testnet", envLabel: "TEST", memo: "ZEB-7Q2K" }));
    fireEvent.click(await screen.findByRole("button", { name: /Pay with Noir Wallet/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Zcash mainnet.*\[Testnet\] Noir Wallet/);
  });
});
