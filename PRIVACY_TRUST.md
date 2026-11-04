# Privacy and trust note — Zeb Scan

1. **What stays private:** sender, receiver and amount are shielded on-chain (Ironwood/Sapling notes). Each checkout uses its own diversified address, so no memo is needed and nothing links invoices on-chain.
2. **What the app reveals, and to whom:**
   - The light-wallet server (`testnet.zec.rocks`, mainnet `zec.rocks`) sees the watcher host's IP and sync timing.
   - The watcher host (Render) holds the receiving account's **viewing key**. It sees every incoming amount and memo, but it cannot spend: there is no seed on the server, and `pay` returns `No Signing Key`.
   - Our database stores quotes, invoice addresses, txids, amounts, masked UPI IDs and envelope-encrypted full UPI IDs. Emails are stored only for email sign-in, and never next to a txid.
   - CoinGecko and Kraken see our price requests.
   - If a live INR payout is ever authorized: P2P.me, its liquidity provider, the receiving bank and TinyFish's hosted browser see the UPI recipient and the INR amount.
   - The published **testnet** demo viewing key reveals that demo wallet's full history. No mainnet viewing key is published.
3. **Who users must trust:** Zeb Scan as the custodial operator, which can link an invoice to a UPI payee; Render for watcher availability and confidentiality of the viewing key; the light-wallet server for availability; P2P.me and TinyFish for any future INR delivery.
4. **What we'd fix next:** Nym for the watcher's traffic; self-hosted Zebra + lightwalletd; offline-generated mainnet keys; deleting payout PII after reconciliation.

Zeb Scan is **not** anonymous or untraceable. Testnet TAZ has no value and never funds real INR.
