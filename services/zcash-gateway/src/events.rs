//! Durable deposit event log with a monotonic cursor. The API pulls `GET /internal/deposits`
//! and deduplicates by `event_id`; replays are harmless by design.

use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositEvent {
    pub event_id: String,
    pub kind: &'static str, // note_seen | note_confirmed | note_reorged
    pub network: &'static str,
    pub pool: &'static str, // orchard | sapling | transparent | ironwood
    pub txid: String,
    pub output_ref: String,
    pub value_zatoshis: String,
    pub address: String,
    pub block_height: Option<u32>,
    pub block_hash: Option<String>,
    pub confirmations: u32,
    pub scan_version: String,
}

pub struct EventLog {
    conn: Mutex<Connection>,
}

impl EventLog {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS invoices (diversifier_index TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, address TEXT NOT NULL UNIQUE, served_at INTEGER NOT NULL);",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Insert unless an event with the same id exists (idempotent).
    pub fn append(&self, e: &DepositEvent) -> rusqlite::Result<()> {
        let body = serde_json::to_string(e).expect("serializable");
        self.conn.lock().unwrap().execute("INSERT OR IGNORE INTO events(event_id, body) VALUES (?1, ?2)", params![e.event_id, body])?;
        Ok(())
    }

    pub fn page(&self, since: Option<i64>, limit: u32) -> rusqlite::Result<(Vec<serde_json::Value>, Option<String>)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT seq, body FROM events WHERE seq > ?1 ORDER BY seq LIMIT ?2")?;
        let rows = stmt.query_map(params![since.unwrap_or(0), limit], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        let mut last = since;
        for row in rows {
            let (seq, body) = row?;
            out.push(serde_json::from_str(&body).expect("stored json"));
            last = Some(seq);
        }
        Ok((out, last.map(|s| s.to_string())))
    }

    /// Record which invoice an index was served to. The SAME index is never served to two invoices.
    pub fn bind_invoice(&self, index: &str, invoice_id: &str, address: &str, now: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<String> = conn
            .query_row("SELECT invoice_id FROM invoices WHERE diversifier_index = ?1", params![index], |r| r.get(0))
            .ok();
        match existing {
            Some(id) if id != invoice_id => Err(format!("diversifier index {index} already served to another invoice")),
            Some(_) => Ok(()),
            None => conn
                .execute("INSERT INTO invoices(diversifier_index, invoice_id, address, served_at) VALUES (?1, ?2, ?3, ?4)", params![index, invoice_id, address, now])
                .map(|_| ())
                .map_err(|e| e.to_string()),
        }
    }
}
