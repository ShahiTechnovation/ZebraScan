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
    lifetimeMs: 900_000, // 15 min: shielded sends + 1 block can take a few minutes
    provider: "Demo constants",
  },
  /**
   * Operator's Zcash MAINNET shielded receiving address, shown on demo checkouts instead of the
   * non-payable placeholder (operator request 2026-11-05). Payments to it are REAL ZEC. This public
   * demo build cannot confirm them or send INR; the operator's watch-only viewing key sees them.
   */
  receiveAddress:
    "u18q08uwzmzc062zn03nf7dsw2q3jkrs5nslgr28pwq29xghu9y8uzvkm77z5fhzcsz882yxj20shh92e303nqw0wjjkw0dnyn00q5j5kgagtnr4txv8q805jl2q07kgrgzytakp2dk6j4spnwfv4fju9ghhc6kwx52gk7xgl0lsvhdxgz",
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
