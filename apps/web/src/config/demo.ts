/**
 * Single source of demo policy. Every number here is an EXAMPLE DEMO POLICY,
 * not market data and not a contractual promise.
 */
export const demoConfig = {
  seedVersion: 3,
  storageKey: "zebscan.demo.v3",
  quote: {
    /** Illustrative only — not market data. */
    usdMicroPerZec: 45_000_000, // 1 ZEC = 45 USD
    inrPerUsdcMinor: 9_000, // 1 USDC = 90 INR
    protocolFeeBps: 100,
    platformFeeBps: 50,
    lifetimeMs: 90_000,
    provider: "Demo constants",
  },
  limits: {
    minInrMinor: 100, // ₹1
    maxInrMinor: 1_000_000, // ₹10,000
  },
  /** Example demo settlement policy: merchant credits unlock after 15 days. */
  cooldownDays: 15,
  requiredConfirmations: 3,
  withdrawal: {
    spreadBps: 75,
    minInrMinor: 10_000, // ₹100
  },
  treasury: {
    usdcTotalMicro: "25000000000", // 25,000 USDC (simulated)
    refillThresholdMicro: "5000000000", // warn under 5,000 USDC free
  },
} as const;

export const DAY_MS = 86_400_000;
export const cooldownMs = () => demoConfig.cooldownDays * DAY_MS;
