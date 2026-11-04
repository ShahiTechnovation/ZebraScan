# UI simplification audit (2026-11-04)

Screenshots: `docs/ui/before/*.png` (CRM-style build) and `docs/ui/after/*.png` (payment-first build), each at 375×812 (`-m`) and 1440×900 (`-d`), captured with `apps/web/tests/shots.mjs` against the production demo build.

## Removed / moved

| Before | After |
| --- | --- |
| Dark "carbon" console theme | Light warm-white palette (`#FAFAF8` / `#FFFFFF` / `#16191C` / `#687078` / `#E5E7E8`), emerald CTA `#20A37A`, deeper emerald `#146D56` for links/focus, mineral `#C4A56C` only on DEMO/TEST badges |
| 240 px fixed sidebar with 11 links (16.7% of 1440 px) | No sidebar (measured: 0 fixed `aside` elements). Top nav with 4 items: Home · Receive · Links · Activity |
| Balance, Counter QR, Settlements, Withdrawals, Receipts, Settings, Help in the sidebar | Profile menu (and the mobile drawer); all routes still work |
| 5-tab mobile bottom bar | 4 tabs (same as desktop) |
| Home: greeting, 3 header buttons, demo callout, 4 KPI tiles, 5-column table, "Balance & cooldown" and "Connections" side panels | Home: shop name + one honest balance sentence, one Available/Locked row, two actions (Receive payment, Create payment link), last 5 payments as a simple list |
| Public nav: How it works · For merchants · Payment links · FAQ + "Open merchant demo" | Pay · Receive, plus Sign in and Connect wallet |
| Hero secondary CTA "Explore merchant dashboard" | "Start accepting ZEC" |
| Display face (Space Grotesk) for headings | One sans (Inter) everywhere |

Primary filled CTAs on the merchant home: 1 (measured). Content width capped at 1040 px; the home column is 640 px.

## Interaction counts (merchant home → new QR)
Before: 1 click (header button among 3 + sidebar item). After: 1 click (single primary "Receive payment"). Scan & Pay flow unchanged in steps; quote errors are now shown with a Retry instead of an endless skeleton.

## Added
- Connect modal: Noir Wallet (recommended), Other Zcash wallet (pay without an account), Continue with email (one-time code), Passkey (shown as **not available** — not faked).
- Checkout: invoice memo shown and copyable when present; "Pay with Noir Wallet" (user-approved shielded send); success copy says "Wallet sent ZEC — waiting for Zeb Scan to detect and confirm it" (never "paid").

## Verification
- Demo Playwright suite: 23/23 pass after the redesign; connected suite 2/2.
- `pnpm lint` (incl. react-hooks) clean. WCAG: text pairs chosen for ≥4.5:1 (ink on emerald 6.0:1, `#146D56` on `#FAFAF8` 6.3:1, `#687078` on `#FAFAF8` ≈4.8:1). No automated axe run was performed — that remains to do.
- Zero HashX copy (grep over `src/` for "HashX" returns nothing).

## Not yet redesigned
Secondary merchant pages (transactions table, balance, settlements, withdrawals, settings) inherit the new palette and nav but keep their previous layouts.
