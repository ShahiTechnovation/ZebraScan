//! Zeb Scan Zcash gateway (watch-only).
//!
//! STATUS: source only — NOT COMPILED OR RUN on the build host. See README.md for the exact
//! verification steps required before this may be enabled (testnet first).
//!
//! Responsibilities
//!  * Holds ONLY a unified incoming viewing key (UIVK). It cannot spend. Spending authority lives
//!    in a separate, offline/isolated treasury signer with two-person approval.
//!  * Derives one unique diversified receiving address per invoice at a caller-supplied,
//!    monotonically allocated diversifier index (the API burns indices in PostgreSQL).
//!  * Scans compact blocks from Zaino/lightwalletd sequentially, trial-decrypting with the UIVK via
//!    `zcash_client_backend`; persists scan state in `zcash_client_sqlite`.
//!  * Emits deposit events keyed by (txid, output identity provided by the wallet), including
//!    reorg notices, through a cursor-paged feed (`GET /internal/deposits`).
//!  * Refuses to serve allocations unless: network matches, tip is fresh, scan lag is within
//!    policy, and the consensus branch at tip is one this build supports (NU6.3 "Ironwood"; NU7
//!    once activated).

mod api;
mod config;
mod events;
mod wallet;

use std::sync::Arc;

use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().json().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();

    let cfg = config::Config::from_env()?;
    info!(network = ?cfg.network, listen = %cfg.listen, "starting zeb-zcash-gateway");

    let events = Arc::new(events::EventLog::open(&cfg.events_db_path)?);
    let wallet = Arc::new(wallet::Wallet::open(&cfg, events.clone()).await?);

    // Background scanner: sequential compact-block sync with persisted cursor.
    let scanner = {
        let wallet = wallet.clone();
        tokio::spawn(async move { wallet.run_scanner().await })
    };

    let app = api::router(api::AppState { wallet, events, cfg: Arc::new(cfg.clone()) });

    // mTLS: the server presents its certificate and REQUIRES a client certificate signed by the
    // internal CA (API and worker hold client certs). No plaintext listener exists.
    let tls = config::mtls_server_config(&cfg)?;
    let server = axum_server::bind_rustls(cfg.listen.parse()?, tls).serve(app.into_make_service());

    tokio::select! {
        r = server => r?,
        _ = tokio::signal::ctrl_c() => info!("shutdown requested"),
    }
    scanner.abort();
    Ok(())
}
