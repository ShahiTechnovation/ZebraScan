//! Internal HTTP API (mTLS only). Shapes match packages/providers/src/zcash.ts.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::{config::Config, events::EventLog, wallet::Wallet};

#[derive(Clone)]
pub struct AppState {
    pub wallet: Arc<Wallet>,
    pub events: Arc<EventLog>,
    pub cfg: Arc<Config>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/internal/scanner/status", get(status))
        .route("/internal/addresses/allocate", post(allocate))
        .route("/internal/deposits", get(deposits))
        .route("/internal/backfill", post(backfill))
        .with_state(state)
}

#[derive(Serialize)]
struct ApiError {
    code: &'static str,
    message: String,
}
type ApiResult<T> = Result<Json<T>, (StatusCode, Json<ApiError>)>;
fn err(status: StatusCode, code: &'static str, message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (status, Json(ApiError { code, message: message.into() }))
}

async fn status(State(s): State<AppState>) -> ApiResult<crate::wallet::ScannerStatus> {
    s.wallet.status().await.map(Json).map_err(|e| err(StatusCode::SERVICE_UNAVAILABLE, "SCANNER_UNAVAILABLE", e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AllocateIn {
    invoice_id: String,
    network: String,
    privacy_mode: String,
    diversifier_index: String,
    amount_zatoshis: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AllocateOut {
    address: String,
    address_type: &'static str,
    receivers: Vec<&'static str>,
    account_id: String,
    diversifier_index: String,
    wallet_id: String,
    birthday_height: u32,
    zip321_uri: String,
}

async fn allocate(State(s): State<AppState>, Json(body): Json<AllocateIn>) -> ApiResult<AllocateOut> {
    if body.network != s.cfg.network_name() {
        return Err(err(StatusCode::BAD_REQUEST, "WALLET_NETWORK_MISMATCH", "network does not match gateway"));
    }
    // Refuse to issue addresses while the scanner cannot see payments to them.
    let st = s.wallet.status().await.map_err(|e| err(StatusCode::SERVICE_UNAVAILABLE, "SCANNER_UNAVAILABLE", e.to_string()))?;
    if st.state != "synced" || !st.ironwood_supported {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, "SCANNER_NOT_READY", format!("scanner state {} (ironwood={})", st.state, st.ironwood_supported)));
    }
    let index: u128 = body.diversifier_index.parse().map_err(|_| err(StatusCode::BAD_REQUEST, "VALIDATION", "diversifierIndex"))?;
    let zat: u64 = body.amount_zatoshis.parse().map_err(|_| err(StatusCode::BAD_REQUEST, "VALIDATION", "amountZatoshis"))?;
    let transparent = match body.privacy_mode.as_str() {
        "shielded" => false,
        "transparent" => true,
        _ => return Err(err(StatusCode::BAD_REQUEST, "VALIDATION", "privacyMode")),
    };
    let a = s
        .wallet
        .address_at(index, transparent)
        .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, "ADDRESS_DERIVATION_FAILED", e.to_string()))?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    s.events
        .bind_invoice(&body.diversifier_index, &body.invoice_id, &a.encoded, now)
        .map_err(|e| err(StatusCode::CONFLICT, "INDEX_ALREADY_SERVED", e))?;
    let uri = crate::wallet::zip321_uri(&s.cfg, &a.encoded, zat).map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, "ZIP321", e))?;
    Ok(Json(AllocateOut {
        address: a.encoded,
        address_type: a.address_type,
        receivers: a.receivers,
        account_id: a.account_id,
        diversifier_index: body.diversifier_index,
        wallet_id: s.wallet.wallet_id(),
        birthday_height: s.cfg.birthday_height,
        zip321_uri: uri,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DepositsQ {
    since_cursor: Option<i64>,
    limit: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DepositsOut {
    events: Vec<serde_json::Value>,
    next_cursor: Option<String>,
}

async fn deposits(State(s): State<AppState>, Query(q): Query<DepositsQ>) -> ApiResult<DepositsOut> {
    let (events, next) = s.events.page(q.since_cursor, q.limit.unwrap_or(200).min(500)).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, "EVENT_LOG", e.to_string()))?;
    Ok(Json(DepositsOut { events, next_cursor: next }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackfillIn {
    from_height: u32,
}

async fn backfill(State(s): State<AppState>, Json(b): Json<BackfillIn>) -> ApiResult<serde_json::Value> {
    if b.from_height < s.cfg.birthday_height {
        return Err(err(StatusCode::BAD_REQUEST, "BACKFILL_BEFORE_BIRTHDAY", "cannot rescan before wallet birthday"));
    }
    s.wallet.request_rescan(b.from_height).await;
    Ok(Json(serde_json::json!({ "accepted": true, "fromHeight": b.from_height })))
}
