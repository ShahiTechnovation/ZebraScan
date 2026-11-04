//! Gateway configuration. Strict: unknown networks or missing key material are fatal.

use std::{fs, sync::Arc};

use axum_server::tls_rustls::RustlsConfig;
use zcash_protocol::consensus::Network;

#[derive(Clone)]
pub struct Config {
    pub network: Network,
    pub listen: String,
    /// Zaino / lightwalletd gRPC endpoint (TLS).
    pub light_client_url: String,
    /// zcash_client_sqlite wallet database (scan state, notes). Encrypted volume.
    pub wallet_db_path: String,
    /// Gateway event log (deposit feed) database.
    pub events_db_path: String,
    /// Path to a file containing the UIVK (encoded per ZIP-316). Never a spending key.
    pub uivk_path: String,
    /// Wallet birthday height (first block that can contain our notes).
    pub birthday_height: u32,
    pub max_scan_lag_blocks: u32,
    pub max_tip_age_secs: u64,
    pub tls_cert_path: String,
    pub tls_key_path: String,
    pub tls_client_ca_path: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is required")]
    Missing(&'static str),
    #[error("ZCASH_NETWORK must be mainnet or testnet")]
    Network,
    #[error("{0} is invalid")]
    Invalid(&'static str),
}

fn req(k: &'static str) -> Result<String, ConfigError> {
    std::env::var(k).map_err(|_| ConfigError::Missing(k))
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let network = match req("ZCASH_NETWORK")?.as_str() {
            "mainnet" => Network::MainNetwork,
            "testnet" => Network::TestNetwork,
            _ => return Err(ConfigError::Network),
        };
        Ok(Self {
            network,
            listen: std::env::var("GATEWAY_LISTEN").unwrap_or_else(|_| "0.0.0.0:8443".into()),
            light_client_url: req("LIGHT_CLIENT_URL")?,
            wallet_db_path: req("WALLET_DB_PATH")?,
            events_db_path: req("EVENTS_DB_PATH")?,
            uivk_path: req("UIVK_PATH")?,
            birthday_height: req("WALLET_BIRTHDAY_HEIGHT")?.parse().map_err(|_| ConfigError::Invalid("WALLET_BIRTHDAY_HEIGHT"))?,
            max_scan_lag_blocks: std::env::var("MAX_SCAN_LAG_BLOCKS").ok().and_then(|v| v.parse().ok()).unwrap_or(3),
            max_tip_age_secs: std::env::var("MAX_TIP_AGE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(900),
            tls_cert_path: req("TLS_CERT_PATH")?,
            tls_key_path: req("TLS_KEY_PATH")?,
            tls_client_ca_path: req("TLS_CLIENT_CA_PATH")?,
        })
    }

    pub fn network_name(&self) -> &'static str {
        match self.network {
            Network::MainNetwork => "mainnet",
            Network::TestNetwork => "testnet",
        }
    }
}

/// rustls server config that requires client certificates from the internal CA.
pub fn mtls_server_config(cfg: &Config) -> Result<RustlsConfig, Box<dyn std::error::Error>> {
    use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
    use rustls::server::WebPkiClientVerifier;

    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(&cfg.tls_cert_path)?.collect::<Result<_, _>>()?;
    let key = PrivateKeyDer::from_pem_file(&cfg.tls_key_path)?;
    let mut roots = rustls::RootCertStore::empty();
    for ca in CertificateDer::pem_file_iter(&cfg.tls_client_ca_path)? {
        roots.add(ca?)?;
    }
    let verifier = WebPkiClientVerifier::builder(Arc::new(roots)).build()?;
    let server = rustls::ServerConfig::builder().with_client_cert_verifier(verifier).with_single_cert(certs, key)?;
    let _ = fs::metadata(&cfg.uivk_path)?; // fail fast if key material is missing
    Ok(RustlsConfig::from_config(Arc::new(server)))
}
