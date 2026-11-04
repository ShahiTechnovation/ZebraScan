/**
 * ScanStatus honesty on HACKATHON_TESTNET: the real payout progress is shown ONLY when the server reports
 * the strict TESTNET_LIVE_PAYOUT_DEMO opt-in (public config `liveDemoPayouts`), always with the funding
 * line; otherwise the existing testnet copy stays and no order tracker is drawn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/scan/pi_testnetdemo000000000000",
}));
vi.mock("@/components/payments/CheckoutPanel", () => ({ CheckoutPanel: () => <div>checkout panel</div> }));

const zeb = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/providers/ZebProvider", () => ({
  useZeb: () => zeb.value,
  useLiveResource: () => ({ loading: false, error: null }),
}));

const ID = "pi_testnetdemo000000000000";
const checkout = {
  id: ID,
  mode: "scan_pay",
  merchantId: null,
  linkId: null,
  createdAt: Date.now(),
  quote: { inrMinor: 5000 },
  privacy: "shielded",
  receivingAddress: "utest1example",
  qrPayload: "zcash:utest1example",
  depositStatus: "accepted",
  deposit: null,
  recipient: { vpa: "de•••ee@okaxis", source: "manual" },
  p2pOrderId: `pay_${ID}`,
  customerNote: "",
  exceptionReason: null,
  events: [],
  simulated: false,
};
const order = (status: string) => ({
  id: `pay_${ID}`,
  orderType: "PAY",
  orderTypeCode: 2,
  status,
  matching: false,
  checkoutId: ID,
  withdrawalId: null,
  inrMinor: 5000,
  usdcMicro: "611112",
  recipientVpa: "de•••ee@okaxis",
  createdAt: Date.now(),
  events: [
    { at: Date.now() - 2000, kind: "payout.payout_queued", label: "Testnet ZEC confirmed — INR payout authorized" },
    { at: Date.now(), kind: "payout.operator_approval_required", label: "Waiting for operator approval" },
  ],
  simulated: false,
});
function useState(liveDemoPayouts: boolean | undefined, status = "placed") {
  zeb.value = {
    ready: true,
    isDemo: false,
    state: { checkouts: [checkout], orders: [order(status)], receipts: [] },
    live: { config: { label: "TEST", environment: "testnet", ...(liveDemoPayouts === undefined ? {} : { liveDemoPayouts }) } },
  };
}
const FUNDING = /INR is paid from Zeb Scan.s own pre-funded P2P\.lol USDC; the testnet payment only authorizes it\./;

afterEach(() => cleanup());

describe("ScanStatus on HACKATHON_TESTNET", () => {
  it("live payout demo: shows the real payout progress with the funding line and the latest update", async () => {
    useState(true);
    const { ScanStatus } = await import("@/components/screens/ScanStatus");
    render(<ScanStatus id={ID} />);
    expect(screen.getByText(FUNDING)).toBeTruthy();
    expect(screen.getByLabelText("INR payout progress")).toBeTruthy();
    expect(screen.getByText("Waiting for operator approval")).toBeTruthy();
    expect(screen.queryByText(/Zcash testnet verified\./)).toBeNull();
  });

  it("live payout demo: an unconfirmed provider outcome is shown as needing review", async () => {
    useState(true, "under_review");
    const { ScanStatus } = await import("@/components/screens/ScanStatus");
    render(<ScanStatus id={ID} />);
    expect(screen.getByText("Payout needs review")).toBeTruthy();
    expect(screen.getByText(/Nothing is retried automatically/)).toBeTruthy();
  });

  it.each([false, undefined])("gate off (liveDemoPayouts=%s): keeps the testnet copy and draws no order tracker", async (flag) => {
    useState(flag);
    const { ScanStatus } = await import("@/components/screens/ScanStatus");
    render(<ScanStatus id={ID} />);
    expect(screen.getByText(/Zcash testnet verified\./)).toBeTruthy();
    expect(screen.queryByText(FUNDING)).toBeNull();
    expect(screen.queryByLabelText("INR payout progress")).toBeNull();
    expect(screen.queryByText(/Latest payout update/)).toBeNull();
  });
});
