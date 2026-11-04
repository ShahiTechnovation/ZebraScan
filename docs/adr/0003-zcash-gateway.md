# ADR-0003 — Watch-only Rust gateway on librustzcash
Status: accepted; implementation BLOCKED (not compiled)

No custom Zcash cryptography. The gateway uses zcash_client_backend/sqlite/keys/address/protocol and zip321 (pinned 2026-10-21 train) with a UIVK only, unique diversified address per invoice, and a cursor-paged event feed keyed by wallet output identity. Zingolib was not chosen because recent Ironwood support could not be verified. Spending is out of scope (separate isolated signer with two-person approval).
