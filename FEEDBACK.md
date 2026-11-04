# Feedback

Draft notes from the build; the builder should edit before submitting.

## SDK or wallet tool — @noir-wallet/sdk 0.1.9
- `verifyMessageSignature` returns `valid: true` when neither `pubkey` nor `address` is passed. Easy to misuse as "signature is valid" when it only means "some key signed something". Expected: require an expected identity, or make `valid` false without one.
- `pubkeyMatch` compares the provided pubkey string to the **uncompressed** recovered key, so a valid signature checked against a compressed pubkey reports `pubkeyMatch: false`. We verify by address instead.
- `buildZcashMessagePayload` prefixes the message length with JS `string.length` (UTF-16 code units), not the UTF-8 byte length, so non-ASCII messages would not match a byte-correct verifier. We keep challenges ASCII-only.
- No `getNetwork()`; recipients must be prefix-checked by the app (documented in the event guide).

## Node or indexer
- zkool_graphql's prebuilt release asset is a Linux binary; on Windows without an enabled WSL2 VM platform (and without Docker/Rust) there was no way to run a headless Ironwood watcher locally.

## SDK — @tiny-fish/sdk 0.11.0
- The client retries by default (`maxRetries`). For money-moving `agent.queue` POSTs a retry can start a second run; we construct the client with `maxRetries: 0`. Worth a prominent note in the docs.

## Other
For each item: what we tried, what happened, what we expected — see above.
