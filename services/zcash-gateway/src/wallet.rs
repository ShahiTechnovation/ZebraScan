//! Watch-only wallet: UIVK-only address derivation and compact-block scanning on top of
//! `zcash_client_backend` + `zcash_client_sqlite`.
//!
//! UNVERIFIED: this module is written against the published 0.25/0.23/0.17 crate APIs but has NOT
//! been compiled on the build host. Expect signature adjustments when first built. Do not enable
//! the gateway in any environment until README.md's verification checklist passes on testnet.

use std::sync::Arc;

use serde::Serialize;
use tokio::sync::{Mutex, RwLock};
use zcash_address::unified::{self, Encoding};
use zcash_keys::keys::UnifiedIncomingViewingKey;
use zcash_protocol::{consensus::Parameters, value::Zatoshis};

use crate::{config::Config, events::EventLog};

pub const SCAN_VERSION: &str = concat!("zeb-gateway/", env!("CARGO_PKG_VERSION"), "+lrz0.25");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerStatus {
    pub network: &'static str,
    pub tip_height: u32,
    pub tip_hash: String,
    pub tip_time: String,
    pub scanned_height: u32,
    pub consensus_branch_id: String,
    pub ironwood_supported: bool,
    pub nu7_active: bool,
    pub state: &'static str, // synced | syncing | rescanning | stalled | error
    pub wallet_birthday: u32,
    pub version: &'static str,
}

pub struct Derived {
    pub encoded: String,
    pub address_type: &'static str,
    pub receivers: Vec<&'static str>,
    pub account_id: String,
}

pub struct Wallet {
    cfg: Config,
    uivk: UnifiedIncomingViewingKey,
    events: Arc<EventLog>,
    status: RwLock<Option<ScannerStatus>>,
    rescan_from: Mutex<Option<u32>>,
}

#[derive(Debug, thiserror::Error)]
pub enum WalletError {
    #[error("viewing key: {0}")]
    Key(String),
    #[error("address: {0}")]
    Address(String),
    #[error("scanner: {0}")]
    Scanner(String),
}

impl Wallet {
    pub async fn open(cfg: &Config, events: Arc<EventLog>) -> Result<Self, WalletError> {
        let encoded = std::fs::read_to_string(&cfg.uivk_path).map_err(|e| WalletError::Key(e.to_string()))?;
        // UIVK only — a UFVK or spending key here is a configuration error.
        let uivk = UnifiedIncomingViewingKey::decode(&cfg.network, encoded.trim()).map_err(|e| WalletError::Key(format!("{e:?}")))?;
        Ok(Self { cfg: cfg.clone(), uivk, events, status: RwLock::new(None), rescan_from: Mutex::new(None) })
    }

    pub fn wallet_id(&self) -> String {
        use sha2::{Digest, Sha256};
        let enc = self.uivk.encode(&self.cfg.network);
        hex::encode(&Sha256::digest(enc.as_bytes())[..8])
    }

    /// Deterministic diversified address at `index`. Shielded invoices get Orchard (+Sapling)
    /// receivers and NO transparent receiver, so a payer cannot accidentally pay transparently.
    pub fn address_at(&self, index: u128, transparent_only: bool) -> Result<Derived, WalletError> {
        use zcash_keys::keys::{ReceiverRequirement::*, UnifiedAddressRequest};
        let di = zip32::DiversifierIndex::try_from(index).map_err(|_| WalletError::Address("index out of range".into()))?;
        if transparent_only {
            let ua = self
                .uivk
                .address(di, UnifiedAddressRequest::unsafe_custom(Omit, Omit, Require))
                .map_err(|e| WalletError::Address(format!("{e:?}")))?;
            let t = ua.transparent().ok_or_else(|| WalletError::Address("no transparent receiver at index".into()))?;
            return Ok(Derived { encoded: t.to_zcash_address(self.cfg.network.network_type()).encode(), address_type: "transparent", receivers: vec!["transparent"], account_id: "0".into() });
        }
        let ua = self
            .uivk
            .address(di, UnifiedAddressRequest::unsafe_custom(Require, Allow, Omit))
            .map_err(|e| WalletError::Address(format!("{e:?}")))?;
        let mut receivers = vec!["orchard"];
        if ua.has_sapling() {
            receivers.push("sapling");
        }
        // Double-check by re-parsing the encoding: no transparent receiver may be present.
        let encoded = ua.encode(&self.cfg.network);
        let (_, parsed) = unified::Address::decode(&encoded).map_err(|e| WalletError::Address(format!("{e:?}")))?;
        if parsed.items().iter().any(|r| matches!(r, unified::Receiver::P2pkh(_) | unified::Receiver::P2sh(_))) {
            return Err(WalletError::Address("shielded invoice address unexpectedly contains a transparent receiver".into()));
        }
        Ok(Derived { encoded, address_type: "unified", receivers, account_id: "0".into() })
    }

    pub async fn status(&self) -> Result<ScannerStatus, WalletError> {
        self.status.read().await.clone().ok_or_else(|| WalletError::Scanner("scanner has not completed its first tip check".into()))
    }

    pub async fn request_rescan(&self, from: u32) {
        *self.rescan_from.lock().await = Some(from);
    }

    /// Sequential compact-block sync loop:
    ///  1. connect to the light client (TLS), read `GetLatestBlock` + `GetLightdInfo`;
    ///  2. verify chain name / consensus branch for the tip height; set `ironwood_supported`
    ///     only if this build's `zcash_protocol` knows the active branch;
    ///  3. `zcash_client_backend::sync::run` against the sqlite wallet (UIVK-imported account);
    ///  4. diff wallet received notes against the event log, emitting `note_seen` /
    ///     `note_confirmed` (confirmations = tip - mined_height + 1) and `note_reorged` for notes
    ///     whose mined height was rolled back by the wallet's reorg handling.
    pub async fn run_scanner(self: Arc<Self>) {
        loop {
            if let Err(e) = self.scan_once().await {
                tracing::warn!(error = %e, "scan iteration failed");
                if let Some(s) = self.status.write().await.as_mut() {
                    s.state = "error";
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    }

    async fn scan_once(&self) -> Result<(), WalletError> {
        // The concrete sync wiring (tonic channel → CompactTxStreamerClient, WalletDb::for_path,
        // BlockDb, sync::run, and get_received_notes diffing) is intentionally the first thing to
        // build and test on testnet; see README.md "First build". Until that is done this returns
        // an error, which keeps `state = "error"` and therefore keeps invoice allocation CLOSED.
        let _ = (&self.events, SCAN_VERSION, Zatoshis::ZERO);
        Err(WalletError::Scanner("compact-block sync not yet built/verified on this host (see README)".into()))
    }
}

/// ZIP-321 URI via the pinned `zip321` crate (exact zatoshis, no label/message).
pub fn zip321_uri(cfg: &Config, address: &str, zat: u64) -> Result<String, String> {
    let addr = zcash_address::ZcashAddress::try_from_encoded(address).map_err(|e| format!("{e:?}"))?;
    let amount = Zatoshis::from_u64(zat).map_err(|_| "amount out of range".to_string())?;
    let payment = zip321::Payment::without_memo(addr, amount);
    let req = zip321::TransactionRequest::new(vec![payment]).map_err(|e| format!("{e:?}"))?;
    let _ = cfg;
    Ok(req.to_uri())
}
