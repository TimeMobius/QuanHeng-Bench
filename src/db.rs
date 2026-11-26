use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, Result as SqlResult, Row};

use crate::models::{DailyTestRecord, RunLogEntry, TrendPoint};

/// Shared SQLite handle. `rusqlite::Connection` is `Send` but not `Sync`, so
/// every access goes through a mutex and is executed inside `spawn_blocking`
/// (see `db_call`) to keep the async runtime free.
pub type Db = Arc<Mutex<Connection>>;

/// Schema version written to `PRAGMA user_version`.
const SCHEMA_VERSION: i64 = 4;

/// Initialize / migrate the database schema.
pub fn init_db(db_path: &Path, tz_offset_hours: i32) -> SqlResult<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA busy_timeout=5000;
         PRAGMA synchronous=NORMAL;",
    )?;
    migrate(&conn, tz_offset_hours)?;
    Ok(conn)
}

/// Wrap an existing connection for sharing.
pub fn shared(conn: Connection) -> Db {
    Arc::new(Mutex::new(conn))
}

fn migrate(conn: &Connection, tz_offset_hours: i32) -> SqlResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS test_records (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            test_date       TEXT NOT NULL,
            model           TEXT NOT NULL,
            concurrency     INTEGER NOT NULL,
            request_count   INTEGER NOT NULL,
            avg_ttft_ms     REAL NOT NULL,
            min_ttft_ms     REAL NOT NULL,
            max_ttft_ms     REAL NOT NULL,
            p50_ttft_ms     REAL NOT NULL,
            p95_ttft_ms     REAL NOT NULL,
            p99_ttft_ms     REAL NOT NULL,
            avg_output_speed_tps REAL NOT NULL DEFAULT 0.0,
            avg_tps         REAL NOT NULL,
            total_tokens    INTEGER NOT NULL,
            success_rate    REAL NOT NULL,
            total_duration_secs REAL NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            error_count     INTEGER NOT NULL DEFAULT 0,
            error_summary   TEXT NOT NULL DEFAULT '',
            created_at_local TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS run_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at      TEXT NOT NULL,
            finished_at     TEXT,
            duration_secs   REAL,
            mode            TEXT NOT NULL,
            target          TEXT,
            status          TEXT NOT NULL,
            message         TEXT,
            record_count    INTEGER NOT NULL DEFAULT 0
        );",
    )?;

    // Columns added after the first release.
    ensure_column(conn, "error_count", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "error_summary", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "created_at_local", "TEXT NOT NULL DEFAULT ''")?;

    // Protocol v2 (schema v4): measurement-caliber metadata. Legacy rows keep
    // the honest defaults (protocol '1', no bust, 'unknown' token source).
    ensure_column(conn, "input_tokens", "REAL NOT NULL DEFAULT 0")?;
    ensure_column(conn, "output_tokens", "REAL NOT NULL DEFAULT 0")?;
    ensure_column(conn, "token_source", "TEXT NOT NULL DEFAULT 'unknown'")?;
    ensure_column(conn, "protocol_version", "TEXT NOT NULL DEFAULT '1'")?;
    ensure_column(conn, "cache_bust", "INTEGER NOT NULL DEFAULT 0")?;

    // Cached capability of the measured endpoint: does it answer
    // `stream_options.include_usage`? Written by the once-per-run probe.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS endpoint_capabilities (
            base_url              TEXT PRIMARY KEY,
            supports_stream_usage INTEGER NOT NULL,
            probed_at             TEXT NOT NULL
        );",
    )?;

    if version < 2 {
        // One-time cleanup of duplicate (test_date, model, concurrency) rows
        // left behind by pre-unique-index databases. Keeping the *latest* row
        // (old code deleted everything newer than MIN(id), which kept stale
        // data); we keep MAX(id) instead.
        conn.execute_batch(
            "DELETE FROM test_records WHERE id NOT IN (
                SELECT MAX(id) FROM test_records GROUP BY test_date, model, concurrency
            );",
        )?;
    }

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_test_date ON test_records(test_date)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_model ON test_records(model)",
        [],
    )?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_test ON test_records(test_date, model, concurrency)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_run_log_started ON run_log(started_at)",
        [],
    )?;

    // Backfill the local timestamp for rows written before the column existed.
    // `created_at` is UTC (SQLite `datetime('now')`), so a fixed offset is a
    // faithful conversion for the configured TZ_OFFSET_HOURS.
    conn.execute(
        &format!(
            "UPDATE test_records
             SET created_at_local = datetime(created_at, '{:+} hours')
             WHERE (created_at_local IS NULL OR created_at_local = '')
               AND created_at IS NOT NULL AND created_at <> ''",
            tz_offset_hours
        ),
        [],
    )?;

    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    Ok(())
}

fn ensure_column(conn: &Connection, column: &str, ddl: &str) -> SqlResult<()> {
    if table_has_column(conn, "test_records", column)? {
        return Ok(());
    }
    conn.execute_batch(&format!(
        "ALTER TABLE test_records ADD COLUMN {column} {ddl};"
    ))
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> SqlResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Mark runs left in `running` state by a crashed/restarted process as failed.
pub fn mark_stale_runs(conn: &Connection, local_now: &str) -> SqlResult<usize> {
    conn.execute(
        "UPDATE run_log
         SET status = 'failed',
             finished_at = COALESCE(finished_at, ?1),
             message = TRIM(COALESCE(message, '') || ' (interrupted by restart)')
         WHERE status = 'running'",
        params![local_now],
    )
}

/// Insert or update a daily test record (upsert)
pub fn insert_record(conn: &Connection, record: &DailyTestRecord) -> SqlResult<i64> {
    let error_summary =
        serde_json::to_string(&record.error_summary).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "INSERT INTO test_records (test_date, model, concurrency, request_count,
         avg_ttft_ms, min_ttft_ms, max_ttft_ms, p50_ttft_ms, p95_ttft_ms, p99_ttft_ms,
         avg_output_speed_tps, avg_tps, total_tokens, success_rate, total_duration_secs,
         created_at, error_count, error_summary, created_at_local,
         input_tokens, output_tokens, token_source, protocol_version, cache_bust)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 datetime('now'), ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
         ON CONFLICT(test_date, model, concurrency) DO UPDATE SET
         request_count=excluded.request_count,
         avg_ttft_ms=excluded.avg_ttft_ms,
         min_ttft_ms=excluded.min_ttft_ms,
         max_ttft_ms=excluded.max_ttft_ms,
         p50_ttft_ms=excluded.p50_ttft_ms,
         p95_ttft_ms=excluded.p95_ttft_ms,
         p99_ttft_ms=excluded.p99_ttft_ms,
         avg_output_speed_tps=excluded.avg_output_speed_tps,
         avg_tps=excluded.avg_tps,
         total_tokens=excluded.total_tokens,
         success_rate=excluded.success_rate,
         total_duration_secs=excluded.total_duration_secs,
         error_count=excluded.error_count,
         error_summary=excluded.error_summary,
         created_at=excluded.created_at,
         created_at_local=excluded.created_at_local,
         input_tokens=excluded.input_tokens,
         output_tokens=excluded.output_tokens,
         token_source=excluded.token_source,
         protocol_version=excluded.protocol_version,
         cache_bust=excluded.cache_bust",
        params![
            record.test_date,
            record.model,
            record.concurrency,
            record.request_count,
            record.avg_ttft_ms,
            record.min_ttft_ms,
            record.max_ttft_ms,
            record.p50_ttft_ms,
            record.p95_ttft_ms,
            record.p99_ttft_ms,
            record.avg_output_speed_tps,
            record.avg_tps,
            record.total_tokens,
            record.success_rate,
            record.total_duration_secs,
            record.error_count,
            error_summary,
            record.created_at_local,
            record.input_tokens,
            record.output_tokens,
            record.token_source,
            record.protocol_version,
            record.cache_bust as i64,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn row_to_record(row: &Row<'_>) -> SqlResult<DailyTestRecord> {
    let raw_summary: String = row.get(18)?;
    let error_summary: BTreeMap<String, usize> = if raw_summary.is_empty() {
        BTreeMap::new()
    } else {
        serde_json::from_str(&raw_summary).unwrap_or_default()
    };

    Ok(DailyTestRecord {
        id: row.get(0)?,
        test_date: row.get(1)?,
        model: row.get(2)?,
        concurrency: row.get(3)?,
        request_count: row.get(4)?,
        avg_ttft_ms: row.get(5)?,
        min_ttft_ms: row.get(6)?,
        max_ttft_ms: row.get(7)?,
        p50_ttft_ms: row.get(8)?,
        p95_ttft_ms: row.get(9)?,
        p99_ttft_ms: row.get(10)?,
        avg_output_speed_tps: row.get(11)?,
        avg_tps: row.get(12)?,
        total_tokens: row.get(13)?,
        success_rate: row.get(14)?,
        total_duration_secs: row.get(15)?,
        created_at: row.get(16)?,
        created_at_local: row.get(17)?,
        error_count: row.get(19)?,
        error_summary,
        input_tokens: row.get(20)?,
        output_tokens: row.get(21)?,
        token_source: row.get(22)?,
        protocol_version: row.get(23)?,
        cache_bust: row.get::<_, i64>(24)? != 0,
    })
}

const RECORD_COLUMNS: &str = "id, test_date, model, concurrency, request_count,
        avg_ttft_ms, min_ttft_ms, max_ttft_ms, p50_ttft_ms, p95_ttft_ms, p99_ttft_ms,
        avg_output_speed_tps, avg_tps, total_tokens, success_rate, total_duration_secs,
        created_at, created_at_local, error_summary, error_count,
        input_tokens, output_tokens, token_source, protocol_version, cache_bust";

/// Get all records for a specific date
pub fn get_records_by_date(conn: &Connection, date: &str) -> SqlResult<Vec<DailyTestRecord>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {RECORD_COLUMNS} FROM test_records WHERE test_date = ?1
         ORDER BY model, concurrency"
    ))?;

    let records = stmt
        .query_map(params![date], row_to_record)?
        .collect::<SqlResult<Vec<_>>>()?;

    Ok(records)
}

/// Get all available test dates (distinct)
pub fn get_available_dates(conn: &Connection) -> SqlResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT DISTINCT test_date FROM test_records ORDER BY test_date DESC")?;

    let dates = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<SqlResult<Vec<_>>>()?;

    Ok(dates)
}

/// Start a run log entry and return its id.
pub fn insert_run_log(
    conn: &Connection,
    started_at: &str,
    mode: &str,
    target: Option<&str>,
) -> SqlResult<i64> {
    conn.execute(
        "INSERT INTO run_log (started_at, mode, target, status) VALUES (?1, ?2, ?3, 'running')",
        params![started_at, mode, target],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Finish a run log entry.
pub fn finish_run_log(
    conn: &Connection,
    id: i64,
    status: &str,
    message: &str,
    record_count: usize,
    finished_at: &str,
    duration_secs: f64,
) -> SqlResult<()> {
    conn.execute(
        "UPDATE run_log
         SET finished_at = ?2, duration_secs = ?3, status = ?4, message = ?5, record_count = ?6
         WHERE id = ?1",
        params![
            id,
            finished_at,
            duration_secs,
            status,
            message,
            record_count as i64
        ],
    )?;
    Ok(())
}

/// Recent run log entries, newest first.
pub fn get_run_logs(conn: &Connection, limit: usize) -> SqlResult<Vec<RunLogEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, started_at, finished_at, duration_secs, mode, target, status, message, record_count
         FROM run_log ORDER BY id DESC LIMIT ?1",
    )?;

    let rows = stmt.query_map(params![limit as i64], |row| {
        Ok(RunLogEntry {
            id: row.get(0)?,
            started_at: row.get(1)?,
            finished_at: row.get(2)?,
            duration_secs: row.get(3)?,
            mode: row.get(4)?,
            target: row.get(5)?,
            status: row.get(6)?,
            message: row.get(7)?,
            record_count: row.get::<_, i64>(8)? as usize,
        })
    })?;

    rows.collect()
}

/// Persist whether the endpoint at `base_url` answers
/// `stream_options.include_usage` with a usage frame (protocol v2 probe).
pub fn upsert_endpoint_capability(
    conn: &Connection,
    base_url: &str,
    supports: bool,
) -> SqlResult<()> {
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    conn.execute(
        "INSERT INTO endpoint_capabilities (base_url, supports_stream_usage, probed_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(base_url) DO UPDATE SET
             supports_stream_usage = excluded.supports_stream_usage,
             probed_at = excluded.probed_at",
        params![base_url, supports as i64, now],
    )?;
    Ok(())
}

/// Previously probed capability for `base_url`, if any.
pub fn load_endpoint_capability(conn: &Connection, base_url: &str) -> SqlResult<Option<bool>> {
    let mut stmt = conn
        .prepare("SELECT supports_stream_usage FROM endpoint_capabilities WHERE base_url = ?1")?;
    let mut rows = stmt.query(params![base_url])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get::<_, i64>(0)? != 0)),
        None => Ok(None),
    }
}

/// Metric column whitelist for the trend endpoint.
pub fn trend_column(metric: &str) -> Option<&'static str> {
    match metric {
        "ttft" => Some("avg_ttft_ms"),
        "p50" => Some("p50_ttft_ms"),
        "p95" => Some("p95_ttft_ms"),
        "p99" => Some("p99_ttft_ms"),
        "tps" => Some("avg_tps"),
        "output" => Some("avg_output_speed_tps"),
        "success" => Some("success_rate"),
        _ => None,
    }
}

/// Daily series for one metric, optionally restricted to one concurrency level.
pub fn get_trend(
    conn: &Connection,
    model: &str,
    metric_column: &str,
    concurrency: Option<usize>,
) -> SqlResult<Vec<TrendPoint>> {
    let sql = format!(
        "SELECT test_date,
                CASE WHEN SUM(request_count) > 0
                     THEN SUM({metric_column} * request_count) / SUM(request_count)
                     ELSE NULL END AS value,
                SUM(request_count) AS requests,
                CASE WHEN SUM(request_count) > 0
                     THEN SUM(success_rate * request_count) / SUM(request_count)
                     ELSE NULL END AS success
         FROM test_records
         WHERE model = ?1 {concurrency_filter}
         GROUP BY test_date
         ORDER BY test_date ASC",
        metric_column = metric_column,
        concurrency_filter = if concurrency.is_some() {
            "AND concurrency = ?2"
        } else {
            ""
        }
    );

    let mut stmt = conn.prepare(&sql)?;
    let map_row = |row: &Row<'_>| -> SqlResult<TrendPoint> {
        Ok(TrendPoint {
            date: row.get(0)?,
            value: row.get(1)?,
            request_count: row.get::<_, i64>(2)? as usize,
            success_rate: row.get(3)?,
        })
    };

    let points = match concurrency {
        Some(level) => stmt
            .query_map(params![model, level as i64], map_row)?
            .collect::<SqlResult<Vec<_>>>()?,
        None => stmt
            .query_map(params![model], map_row)?
            .collect::<SqlResult<Vec<_>>>()?,
    };

    Ok(points)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DailyTestRecord;
    use std::collections::BTreeMap;

    fn temp_db_path(test_name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "quanheng-test-{}-{}",
            test_name,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join("records.db")
    }

    fn sample_record(date: &str, model: &str, concurrency: usize, ttft: f64) -> DailyTestRecord {
        let mut error_summary = BTreeMap::new();
        error_summary.insert("HTTP 429: slow down".to_string(), 2usize);
        DailyTestRecord {
            id: 0,
            test_date: date.to_string(),
            model: model.to_string(),
            concurrency,
            request_count: 16,
            error_count: 2,
            error_summary,
            avg_ttft_ms: ttft,
            min_ttft_ms: ttft - 10.0,
            max_ttft_ms: ttft + 10.0,
            p50_ttft_ms: ttft,
            p95_ttft_ms: ttft + 5.0,
            p99_ttft_ms: ttft + 9.0,
            avg_output_speed_tps: 40.0,
            avg_tps: 38.0,
            total_tokens: 4096,
            input_tokens: 128.0,
            output_tokens: 256.0,
            token_source: "usage".to_string(),
            protocol_version: "2".to_string(),
            cache_bust: true,
            success_rate: 87.5,
            total_duration_secs: 12.5,
            created_at: "2026-08-27 03:00:00".to_string(),
            created_at_local: "2026-08-27 11:00:00".to_string(),
        }
    }

    #[test]
    fn upsert_roundtrip_keeps_error_metadata_and_local_timestamp() {
        let path = temp_db_path("upsert");
        let conn = init_db(&path, 8).expect("init db");

        insert_record(&conn, &sample_record("2026-08-27", "model-a", 8, 800.0)).unwrap();
        insert_record(&conn, &sample_record("2026-08-27", "model-a", 8, 900.0)).unwrap();

        let records = get_records_by_date(&conn, "2026-08-27").unwrap();
        assert_eq!(
            records.len(),
            1,
            "unique index must upsert instead of appending"
        );
        assert_eq!(records[0].avg_ttft_ms, 900.0);
        assert_eq!(records[0].error_count, 2);
        assert_eq!(records[0].error_summary["HTTP 429: slow down"], 2);
        assert_eq!(records[0].created_at_local, "2026-08-27 11:00:00");
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn trend_aggregates_per_day_and_can_filter_by_concurrency() {
        let path = temp_db_path("trend");
        let conn = init_db(&path, 8).expect("init db");

        insert_record(&conn, &sample_record("2026-08-25", "m", 1, 100.0)).unwrap();
        insert_record(&conn, &sample_record("2026-08-25", "m", 8, 300.0)).unwrap();
        insert_record(&conn, &sample_record("2026-08-26", "m", 8, 500.0)).unwrap();

        let all = get_trend(&conn, "m", trend_column("ttft").unwrap(), None).unwrap();
        assert_eq!(all.len(), 2);
        // Both records carry 16 requests, so the daily value is the plain mean.
        assert!((all[0].value.unwrap() - 200.0).abs() < 1e-9);
        assert!((all[1].value.unwrap() - 500.0).abs() < 1e-9);

        let only_eight = get_trend(&conn, "m", trend_column("ttft").unwrap(), Some(8)).unwrap();
        assert_eq!(only_eight.len(), 2);
        assert!((only_eight[0].value.unwrap() - 300.0).abs() < 1e-9);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn run_log_roundtrip_and_stale_marking() {
        let path = temp_db_path("runlog");
        let conn = init_db(&path, 8).expect("init db");

        let id = insert_run_log(&conn, "2026-08-27 03:00:00", "full", None).unwrap();
        finish_run_log(
            &conn,
            id,
            "success",
            "Test completed: 14 records saved",
            14,
            "2026-08-27 03:12:00",
            720.0,
        )
        .unwrap();

        let logs = get_run_logs(&conn, 10).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].status, "success");
        assert_eq!(logs[0].record_count, 14);

        let stale = insert_run_log(&conn, "2026-08-27 04:00:00", "model", Some("m")).unwrap();
        mark_stale_runs(&conn, "2026-08-27 05:00:00").unwrap();
        let logs = get_run_logs(&conn, 10).unwrap();
        let interrupted = logs.iter().find(|entry| entry.id == stale).unwrap();
        assert_eq!(interrupted.status, "failed");
        assert!(interrupted
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("interrupted"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn schema_v4_adds_protocol_columns_and_capability_table() {
        let path = temp_db_path("v4-migrate");
        // Simulate a v3-era database: the old table shape, no protocol columns.
        {
            let conn = Connection::open(&path).expect("open");
            conn.execute_batch(
                "CREATE TABLE test_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    test_date TEXT NOT NULL,
                    model TEXT NOT NULL,
                    concurrency INTEGER NOT NULL,
                    request_count INTEGER NOT NULL,
                    avg_ttft_ms REAL NOT NULL,
                    min_ttft_ms REAL NOT NULL,
                    max_ttft_ms REAL NOT NULL,
                    p50_ttft_ms REAL NOT NULL,
                    p95_ttft_ms REAL NOT NULL,
                    p99_ttft_ms REAL NOT NULL,
                    avg_output_speed_tps REAL NOT NULL DEFAULT 0.0,
                    avg_tps REAL NOT NULL,
                    total_tokens INTEGER NOT NULL,
                    success_rate REAL NOT NULL,
                    total_duration_secs REAL NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    error_count INTEGER NOT NULL DEFAULT 0,
                    error_summary TEXT NOT NULL DEFAULT '',
                    created_at_local TEXT NOT NULL DEFAULT ''
                );
                PRAGMA user_version = 3;",
            )
            .unwrap();
        }

        let migrated = init_db(&path, 8).expect("migrate to v4");
        let version: i64 = migrated
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 4);

        for column in [
            "input_tokens",
            "output_tokens",
            "token_source",
            "protocol_version",
            "cache_bust",
        ] {
            assert!(
                table_has_column(&migrated, "test_records", column).unwrap(),
                "missing column {column}"
            );
        }
        let has_table: bool = migrated
            .query_row(
                "SELECT count(*) > 0 FROM sqlite_master WHERE name = 'endpoint_capabilities'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(has_table, "endpoint_capabilities table missing");

        // Legacy rows keep honest defaults (protocol v1, no bust, unknown source).
        migrated
            .execute(
                "INSERT INTO test_records (test_date, model, concurrency, request_count,
                 avg_ttft_ms, min_ttft_ms, max_ttft_ms, p50_ttft_ms, p95_ttft_ms, p99_ttft_ms,
                 avg_output_speed_tps, avg_tps, total_tokens, success_rate, total_duration_secs)
                 VALUES ('2026-08-27', 'legacy', 8, 10, 100, 90, 110, 100, 105, 109, 20, 18,
                         2000, 100, 10)",
                [],
            )
            .unwrap();
        let legacy = get_records_by_date(&migrated, "2026-08-27")
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(legacy.protocol_version, "1");
        assert_eq!(legacy.token_source, "unknown");
        assert!(!legacy.cache_bust);
        assert_eq!(legacy.input_tokens, 0.0);

        // New records round-trip the protocol metadata.
        let mut sample = sample_record("2026-08-28", "model-v2", 8, 800.0);
        sample.id = 0;
        insert_record(&migrated, &sample).unwrap();
        let v2 = get_records_by_date(&migrated, "2026-08-28")
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(v2.protocol_version, "2");
        assert_eq!(v2.token_source, "usage");
        assert!(v2.cache_bust);
        assert_eq!(v2.input_tokens, 128.0);
        assert_eq!(v2.output_tokens, 256.0);

        // Capability roundtrip.
        upsert_endpoint_capability(&migrated, "http://a", true).unwrap();
        upsert_endpoint_capability(&migrated, "http://a", false).unwrap();
        upsert_endpoint_capability(&migrated, "http://b", true).unwrap();
        assert_eq!(
            load_endpoint_capability(&migrated, "http://a").unwrap(),
            Some(false),
            "re-probe overwrites the previous answer"
        );
        assert_eq!(
            load_endpoint_capability(&migrated, "http://b").unwrap(),
            Some(true)
        );
        assert_eq!(
            load_endpoint_capability(&migrated, "http://c").unwrap(),
            None
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
