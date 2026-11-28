use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A single model returned by /v1/models
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)] // fields mirror the upstream payload; not all are displayed
pub struct ModelInfo {
    pub id: String,
    #[serde(default)]
    pub object: Option<String>,
    #[serde(default)]
    pub created: Option<i64>,
    #[serde(default)]
    pub owned_by: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ModelsResponse {
    pub data: Vec<ModelInfo>,
    #[serde(default)]
    pub object: Option<String>,
}

/// Chat completion request payload
#[derive(Debug, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: u32,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<StreamOptions>,
}

#[derive(Debug, Serialize)]
pub struct StreamOptions {
    pub include_usage: bool,
}

#[derive(Debug, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// A streamed chat completion chunk
#[derive(Debug, Deserialize)]
pub struct ChatChunk {
    #[serde(default)]
    pub choices: Vec<ChunkChoice>,
    #[serde(default)]
    pub usage: Option<UsageInfo>,
    /// Some gateways report failures as a 200 SSE frame: `{"error": {...}}`.
    #[serde(default)]
    pub error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ChunkChoice {
    #[serde(default)]
    pub delta: DeltaContent,
    #[serde(default)]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub index: i64,
}

#[derive(Debug, Deserialize, Default)]
pub struct DeltaContent {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub reasoning_content: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct UsageInfo {
    #[serde(default)]
    pub completion_tokens: Option<i64>,
    #[serde(default)]
    pub prompt_tokens: Option<i64>,
    #[serde(default)]
    pub total_tokens: Option<i64>,
}

/// Results for a single request
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RequestResult {
    pub model: String,
    pub concurrency: usize,
    pub ttft_ms: f64,
    pub output_speed_tps: f64,
    pub tokens_per_second: f64,
    pub total_tokens: i64,
    /// Input tokens of this request: `usage.prompt_tokens` when the server
    /// answered usage, otherwise the character estimate of the prompt.
    pub prompt_tokens: i64,
    /// True when the server returned a usage frame (exact-token caliber).
    pub used_usage: bool,
    /// Measured wall-clock of this single request (send → last byte).
    ///
    /// Kept separate from TTFT + generation: it is the actual observed
    /// duration, used to decide whether `concurrency` requests really ran in
    /// parallel (wave theory vs. real clock).
    pub single_request_ms: f64,
    pub success: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

impl RequestResult {
    pub fn failure(
        model: &str,
        concurrency: usize,
        ttft_ms: f64,
        error: impl Into<String>,
    ) -> Self {
        RequestResult {
            model: model.to_string(),
            concurrency,
            ttft_ms,
            output_speed_tps: 0.0,
            tokens_per_second: 0.0,
            total_tokens: 0,
            prompt_tokens: 0,
            used_usage: false,
            single_request_ms: 0.0,
            success: false,
            cancelled: false,
            error: Some(error.into()),
        }
    }

    pub fn cancelled(model: &str, concurrency: usize) -> Self {
        RequestResult {
            model: model.to_string(),
            concurrency,
            ttft_ms: 0.0,
            output_speed_tps: 0.0,
            tokens_per_second: 0.0,
            total_tokens: 0,
            prompt_tokens: 0,
            used_usage: false,
            single_request_ms: 0.0,
            success: false,
            cancelled: true,
            error: Some("cancelled".to_string()),
        }
    }
}

/// Aggregated results for one model + concurrency level
#[derive(Debug, Clone, Serialize)]
pub struct AggregatedResult {
    pub model: String,
    pub concurrency: usize,
    pub request_count: usize,
    pub error_count: usize,
    pub avg_ttft_ms: f64,
    pub min_ttft_ms: f64,
    pub max_ttft_ms: f64,
    pub p50_ttft_ms: f64,
    pub p95_ttft_ms: f64,
    pub p99_ttft_ms: f64,
    pub avg_output_speed_tps: f64,
    pub avg_tps: f64,
    pub total_tokens: i64,
    /// Mean input tokens per successful request (usage or estimate).
    pub input_tokens_avg: f64,
    /// Mean output tokens per successful request.
    pub output_tokens_avg: f64,
    /// "usage" when any request in this level received an exact usage frame,
    /// otherwise "estimate" (character-based token heuristic).
    pub token_source: String,
    /// Measured single-request wall clock (mean over successful requests).
    pub single_request_ms: f64,
    /// Requests issued / concurrency: how many sequential waves this level ran.
    pub wave_count: f64,
    /// `total_duration_secs / (wave_count × single_request_ms)`.
    /// ≈1.0 means all `concurrency` requests truly overlapped (the level is not
    /// saturated yet); >1 means requests queued behind each other.
    pub saturation_ratio: f64,
    pub success_rate: f64,
    pub total_duration_secs: f64,
    #[serde(skip)]
    pub error_summary: BTreeMap<String, usize>,
}

/// Daily test summary stored in DB
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyTestRecord {
    pub id: i64,
    pub test_date: String,
    pub model: String,
    pub concurrency: usize,
    pub request_count: usize,
    #[serde(default)]
    pub error_count: usize,
    #[serde(default)]
    pub error_summary: BTreeMap<String, usize>,
    pub avg_ttft_ms: f64,
    pub min_ttft_ms: f64,
    pub max_ttft_ms: f64,
    pub p50_ttft_ms: f64,
    pub p95_ttft_ms: f64,
    pub p99_ttft_ms: f64,
    pub avg_output_speed_tps: f64,
    pub avg_tps: f64,
    pub total_tokens: i64,
    /// Mean input tokens per request (0 for legacy v1 records).
    #[serde(default)]
    pub input_tokens: f64,
    /// Mean output tokens per request (0 for legacy v1 records).
    #[serde(default)]
    pub output_tokens: f64,
    /// "usage" | "estimate" | "unknown" (legacy v1 records cannot be told).
    #[serde(default)]
    pub token_source: String,
    /// Measurement protocol the record was produced under ("1" legacy / "2").
    #[serde(default)]
    pub protocol_version: String,
    /// Whether prefix-cache busting was active for this record.
    #[serde(default)]
    pub cache_bust: bool,
    /// Measured single-request wall clock (ms). 0 for legacy v1 records.
    #[serde(default)]
    pub single_request_ms: f64,
    /// Sequential waves this level ran (`request_count / concurrency`).
    #[serde(default)]
    pub wave_count: f64,
    /// Real clock vs. ideal parallel clock; ≈1 = not saturated, >1 = queued.
    #[serde(default)]
    pub saturation_ratio: f64,
    pub success_rate: f64,
    pub total_duration_secs: f64,
    pub created_at: String,
    #[serde(default)]
    pub created_at_local: String,
}

/// Weighted summary over a set of records.
///
/// All averages are weighted by `request_count`, so a level that produced
/// 64 requests does not weigh the same as one that produced 3.
#[derive(Debug, Clone, Serialize, Default)]
pub struct Summary {
    pub models: usize,
    pub models_tested: usize,
    pub requests: usize,
    pub error_count: usize,
    pub tokens: i64,
    pub avg_ttft_ms: Option<f64>,
    pub p95_ttft_ms: Option<f64>,
    pub avg_output_speed_tps: Option<f64>,
    pub avg_tps: Option<f64>,
    pub success_rate: Option<f64>,
    pub duration_secs: f64,
    pub max_concurrency: usize,
}

impl Summary {
    pub fn from_records(records: &[DailyTestRecord]) -> Self {
        let mut models: Vec<&str> = records.iter().map(|r| r.model.as_str()).collect();
        models.sort_unstable();
        models.dedup();

        // `requests` counts attempts (successes + failures): a run where every
        // request failed must still report success_rate = 0, not NULL.
        let attempts: usize = records
            .iter()
            .map(|r| r.request_count + r.error_count)
            .sum();
        // Latency/throughput only exist for successful requests.
        let successful: usize = records.iter().map(|r| r.request_count).sum();
        let weight_by = |total: usize, pick: fn(&DailyTestRecord) -> f64| -> Option<f64> {
            if total == 0 {
                None
            } else {
                Some(
                    records
                        .iter()
                        .map(|r| pick(r) * r.request_count as f64)
                        .sum::<f64>()
                        / total as f64,
                )
            }
        };
        let success_weight = |pick: fn(&DailyTestRecord) -> f64| -> Option<f64> {
            if attempts == 0 {
                None
            } else {
                Some(
                    records
                        .iter()
                        .map(|r| pick(r) * (r.request_count + r.error_count) as f64)
                        .sum::<f64>()
                        / attempts as f64,
                )
            }
        };

        Summary {
            models: models.len(),
            models_tested: models.len(),
            requests: attempts,
            error_count: records.iter().map(|r| r.error_count).sum(),
            tokens: records.iter().map(|r| r.total_tokens).sum(),
            avg_ttft_ms: weight_by(successful, |r| r.avg_ttft_ms),
            p95_ttft_ms: weight_by(successful, |r| r.p95_ttft_ms),
            avg_output_speed_tps: weight_by(successful, |r| r.avg_output_speed_tps),
            avg_tps: weight_by(successful, |r| r.avg_tps),
            success_rate: success_weight(|r| r.success_rate),
            duration_secs: records
                .iter()
                .map(|r| r.total_duration_secs)
                .sum::<f64>()
                .max(0.0),
            max_concurrency: records.iter().map(|r| r.concurrency).max().unwrap_or(0),
        }
    }
}

/// One model as exposed by the dashboard payload.
#[derive(Debug, Clone, Serialize)]
pub struct DashboardModel {
    pub id: String,
    pub icon: String,
    pub tested: bool,
    pub status: String,
    pub has_data: bool,
    pub records: Vec<DailyTestRecord>,
    pub summary: Summary,
}

#[derive(Debug, Clone, Serialize)]
pub struct BestEntry {
    pub model: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct BestSummary {
    pub ttft: Option<BestEntry>,
    pub tps: Option<BestEntry>,
    pub output_speed: Option<BestEntry>,
    pub success_rate: Option<BestEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScheduledView {
    pub hour: u32,
    pub minute: u32,
    pub cron_utc: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigView {
    pub base_url: String,
    pub concurrency_levels: Vec<usize>,
    pub requests_per_level: usize,
    pub test_runs: usize,
    pub questions_per_run: usize,
    pub max_tokens: u32,
    /// Effective output budget (`OUTPUT_TOKENS`, else `MAX_TOKENS`).
    pub output_tokens: u32,
    /// Target input length in tokens (0 = question bank as-is).
    pub input_tokens: u32,
    /// "auto" | "on" | "off" — how exact token usage is obtained.
    pub stream_include_usage: String,
    /// Protocol v2 prefix-cache busting active?
    pub cache_bust: bool,
    /// One-off model-level warm-up request count.
    pub warmup_requests: usize,
    /// Minimum waves per level (requests ≥ min_waves × concurrency).
    pub min_waves: usize,
    /// Measurement protocol implemented by this binary ("2").
    pub protocol_version: String,
    pub request_timeout_secs: u64,
    pub timezone_offset_hours: i32,
    pub scheduled: ScheduledView,
    pub models_cache_secs: u64,
    pub cancel_supported: bool,
    pub version: String,
}

/// Per-model progress while a run is in flight.
#[derive(Debug, Clone, Serialize)]
pub struct ModelProgressView {
    pub name: String,
    pub total: usize,
    pub completed: usize,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusView {
    pub running: bool,
    pub cancel_requested: bool,
    pub message: Option<String>,
    pub progress: Option<f64>,
    pub total_requests: Option<usize>,
    pub completed_requests: Option<usize>,
    pub elapsed_secs: Option<f64>,
    pub started_at: Option<String>,
    pub last_run: Option<String>,
    pub last_run_status: Option<String>,
    pub models: Vec<ModelProgressView>,
}

/// Status for running tests
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TestStatus {
    pub running: bool,
    pub progress: Option<f64>,
    pub total_requests: Option<usize>,
    pub completed_requests: Option<usize>,
    pub message: Option<String>,
    pub last_run: Option<String>,
    pub last_run_status: Option<String>,
    pub started_at: Option<String>,
    pub elapsed_secs: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardResponse {
    pub date: String,
    pub today: String,
    pub dates: Vec<String>,
    pub models: Vec<DashboardModel>,
    pub summary: Summary,
    pub best: BestSummary,
    pub status: StatusView,
    pub config: ConfigView,
    pub run_log: Vec<RunLogEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunLogEntry {
    pub id: i64,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_secs: Option<f64>,
    pub mode: String,
    pub target: Option<String>,
    pub status: String,
    pub message: Option<String>,
    pub record_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrendPoint {
    pub date: String,
    pub value: Option<f64>,
    pub request_count: usize,
    pub success_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrendResponse {
    pub model: String,
    pub metric: String,
    pub concurrency: Option<usize>,
    pub points: Vec<TrendPoint>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelsView {
    pub models: Vec<ModelInfo>,
    pub fetched_at: String,
    pub cached: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RunModelRequest {
    pub model: String,
}

#[derive(Debug, Deserialize)]
pub struct DashboardQuery {
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TrendQuery {
    pub model: String,
    #[serde(default)]
    pub metric: Option<String>,
    #[serde(default)]
    pub concurrency: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct ExportQuery {
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RunLogQuery {
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct ModelsQuery {
    #[serde(default)]
    pub refresh: Option<String>,
}

/// Return today's date string (YYYY-MM-DD) in the configured timezone.
/// e.g. offset_hours=8 for UTC+8, offset_hours=-5 for UTC-5.
pub fn today_local(offset_hours: i32) -> String {
    local_now(offset_hours)
        .get(0..10)
        .unwrap_or_default()
        .to_string()
}

/// Current local timestamp formatted as `YYYY-MM-DD HH:MM:SS`.
pub fn local_now(offset_hours: i32) -> String {
    let local = chrono::Utc::now() + chrono::Duration::hours(offset_hours as i64);
    local.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Validate a strictly zero-padded `YYYY-MM-DD` date string.
///
/// chrono would accept `2026-8-27`; because dates are compared as stored
/// strings, a non-padded value would silently match no rows instead of being
/// rejected as bad input.
pub fn is_valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

/// Compute the four-level health indicator used across the UI.
pub fn health_status(records: &[DailyTestRecord]) -> &'static str {
    if records.is_empty() {
        return "none";
    }
    if records.iter().all(|r| r.success_rate >= 99.0) {
        "good"
    } else if records.iter().any(|r| r.success_rate < 80.0) {
        "bad"
    } else {
        "warn"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(
        model: &str,
        concurrency: usize,
        request_count: usize,
        error_count: usize,
        ttft: f64,
        tps: f64,
        success_rate: f64,
    ) -> DailyTestRecord {
        DailyTestRecord {
            id: 0,
            test_date: "2026-08-27".to_string(),
            model: model.to_string(),
            concurrency,
            request_count,
            error_count,
            error_summary: BTreeMap::new(),
            avg_ttft_ms: ttft,
            min_ttft_ms: ttft,
            max_ttft_ms: ttft,
            p50_ttft_ms: ttft,
            p95_ttft_ms: ttft,
            p99_ttft_ms: ttft,
            avg_output_speed_tps: tps,
            avg_tps: tps,
            total_tokens: 100,
            input_tokens: 0.0,
            output_tokens: 0.0,
            token_source: String::new(),
            protocol_version: "1".to_string(),
            cache_bust: false,
            single_request_ms: 0.0,
            wave_count: 0.0,
            saturation_ratio: 0.0,
            success_rate,
            total_duration_secs: 10.0,
            created_at: "2026-08-27 00:00:00".to_string(),
            created_at_local: "2026-08-27 08:00:00".to_string(),
        }
    }

    #[test]
    fn summary_counts_attempts_and_weights_by_request_count() {
        // 3 requests at 100ms + 1 request at 500ms -> weighted 200ms.
        let records = vec![
            record("m", 1, 3, 1, 100.0, 10.0, 75.0),
            record("m", 8, 1, 0, 500.0, 30.0, 100.0),
        ];
        let summary = Summary::from_records(&records);
        assert_eq!(summary.requests, 5, "attempts = successes + failures");
        assert_eq!(summary.error_count, 1);
        assert_eq!(summary.tokens, 200);
        assert!((summary.avg_ttft_ms.unwrap() - 200.0).abs() < 1e-9);
        assert!((summary.avg_tps.unwrap() - 15.0).abs() < 1e-9);
        // success_rate is weighted by attempts: (75*4 + 100*1) / 5
        assert!((summary.success_rate.unwrap() - 80.0).abs() < 1e-9);
        assert_eq!(summary.max_concurrency, 8);
        assert!((summary.duration_secs - 20.0).abs() < 1e-9);
    }

    #[test]
    fn summary_of_a_total_failure_reports_zero_success_rate() {
        let records = vec![record("m", 1, 0, 3, 0.0, 0.0, 0.0)];
        let summary = Summary::from_records(&records);
        assert_eq!(summary.requests, 3);
        assert_eq!(summary.error_count, 3);
        assert_eq!(summary.success_rate, Some(0.0));
        assert_eq!(
            summary.avg_ttft_ms, None,
            "no successful request has a latency"
        );
    }

    #[test]
    fn summary_of_empty_records_is_null_not_nan() {
        let summary = Summary::from_records(&[]);
        assert_eq!(summary.requests, 0);
        assert_eq!(summary.tokens, 0);
        assert!(summary.avg_ttft_ms.is_none());
        assert!(summary.success_rate.is_none());
        assert_eq!(summary.max_concurrency, 0);
    }

    #[test]
    fn health_status_uses_documented_thresholds() {
        assert_eq!(health_status(&[]), "none");
        assert_eq!(
            health_status(&[record("m", 1, 10, 0, 1.0, 1.0, 99.0)]),
            "good"
        );
        assert_eq!(
            health_status(&[record("m", 1, 10, 1, 1.0, 1.0, 95.0)]),
            "warn"
        );
        assert_eq!(
            health_status(&[record("m", 1, 10, 9, 1.0, 1.0, 10.0)]),
            "bad"
        );
    }

    #[test]
    fn date_validation_rejects_malformed_input() {
        assert!(is_valid_date("2026-08-27"));
        assert!(!is_valid_date("2026-8-27"));
        assert!(!is_valid_date("../../etc/passwd"));
        assert!(!is_valid_date(""));
    }
}
