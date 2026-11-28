use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{header, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use minijinja::Environment;
use rusqlite::Connection;
use serde_json::json;
use tokio::sync::Mutex;
use tower_http::services::ServeDir;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::db::{self, Db};
use crate::icons;
use crate::models::*;
use crate::tester::{RunProgress, TestRunner};

/// Upper bound for the best-effort `/v1/models` fetch behind the dashboard.
const MODELS_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Cached `/v1/models` result. Keeps page loads fast and lets the dashboard
/// keep rendering when the upstream API is temporarily unavailable.
pub struct ModelsCache {
    ttl: Duration,
    inner: Mutex<Option<CacheEntry>>,
}

struct CacheEntry {
    fetched_at: Instant,
    fetched_at_local: String,
    models: Vec<ModelInfo>,
    error: Option<String>,
}

impl ModelsCache {
    pub fn new(ttl: Duration) -> Self {
        ModelsCache {
            ttl,
            inner: Mutex::new(None),
        }
    }

    pub async fn view(&self, runner: &TestRunner, refresh: bool, tz_offset: i32) -> ModelsView {
        let mut guard = self.inner.lock().await;
        if !refresh {
            if let Some(entry) = guard.as_ref() {
                if entry.fetched_at.elapsed() < self.ttl {
                    return ModelsView {
                        models: entry.models.clone(),
                        fetched_at: entry.fetched_at_local.clone(),
                        cached: true,
                        error: entry.error.clone(),
                    };
                }
            }
        }

        // Never let a slow/hung upstream block dashboard requests for the full
        // per-request timeout (up to 30 min): the model list is best-effort.
        let fetch_result =
            match tokio::time::timeout(MODELS_FETCH_TIMEOUT, runner.fetch_models()).await {
                Ok(result) => result,
                Err(_) => Err(format!(
                    "Models API timed out after {}s",
                    MODELS_FETCH_TIMEOUT.as_secs()
                )),
            };

        match fetch_result {
            Ok(models) => {
                let entry = CacheEntry {
                    fetched_at: Instant::now(),
                    fetched_at_local: local_now(tz_offset),
                    models: models.clone(),
                    error: None,
                };
                *guard = Some(entry);
                ModelsView {
                    models,
                    fetched_at: local_now(tz_offset),
                    cached: false,
                    error: None,
                }
            }
            Err(error) => {
                warn!(error = %error, "Failed to fetch models");
                if let Some(entry) = guard.as_ref() {
                    // Serve the stale list rather than an empty page.
                    return ModelsView {
                        models: entry.models.clone(),
                        fetched_at: entry.fetched_at_local.clone(),
                        cached: true,
                        error: Some(error),
                    };
                }
                ModelsView {
                    models: Vec::new(),
                    fetched_at: local_now(tz_offset),
                    cached: false,
                    error: Some(error),
                }
            }
        }
    }
}

/// Application state shared across handlers
pub struct AppState {
    pub config: Arc<Config>,
    pub db: Db,
    pub runner: TestRunner,
    pub progress: Arc<RunProgress>,
    pub test_status: Mutex<TestStatus>,
    pub template_env: Environment<'static>,
    pub models_cache: ModelsCache,
    /// Guards "only one run at a time" across manual, scheduled and startup runs.
    pub run_active: AtomicBool,
}

/// Liveness/readiness probe: process + database reachability (no auth).
async fn healthz(State(state): State<Arc<AppState>>) -> Response {
    let db_ok = db_query(&state.db, |conn| {
        conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
            .map(|_| ())
    })
    .await
    .is_ok();
    let status = if db_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "status": if db_ok { "ok" } else { "degraded" },
            "version": env!("CARGO_PKG_VERSION"),
            "protocol_version": crate::config::PROTOCOL_VERSION,
            "database": db_ok,
            "running": state.run_active.load(Ordering::SeqCst),
        })),
    )
        .into_response()
}

/// Build the router with all routes
pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/", get(dashboard))
        .route("/history/:date", get(history_page))
        .route("/api/dashboard", get(api_dashboard))
        .route("/api/today", get(api_today))
        .route("/api/history/:date", get(api_history))
        .route("/api/dates", get(api_dates))
        .route("/api/status", get(api_status))
        .route("/api/run-test", post(api_run_test))
        .route("/api/run-model", post(api_run_model))
        .route("/api/cancel", post(api_cancel))
        .route("/api/config", get(api_config))
        .route("/api/models", get(api_models))
        .route("/api/trend", get(api_trend))
        .route("/api/run-log", get(api_run_log))
        .route("/api/export.csv", get(api_export_csv))
        .nest_service("/assets", ServeDir::new(resolve_assets_dir(&state.config)))
        .nest_service("/icons", ServeDir::new(icons_dir(&state.config)))
        .with_state(state)
}

/// Resolve the static asset directory at runtime.
///
/// `ServeDir::new(concat!(env!("CARGO_MANIFEST_DIR"), "/assets"))` baked the
/// build machine's path into the binary, which only worked by accident in the
/// Docker image (WORKDIR /app). Probe deployment-friendly locations instead.
fn resolve_assets_dir(config: &Config) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = &config.assets_dir {
        candidates.push(dir.clone());
    }
    candidates.push(PathBuf::from("./assets"));
    candidates.push(PathBuf::from("/app/assets"));
    candidates.push(PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/assets"
    )));

    for candidate in &candidates {
        if candidate.join("vendor/chart.js/chart.umd.min.js").exists() {
            info!(dir = %candidate.display(), "Serving static assets");
            return candidate.clone();
        }
    }
    warn!(
        candidates = ?candidates,
        "No asset directory found; /assets will 404"
    );
    PathBuf::from("./assets")
}

fn icons_dir(config: &Config) -> PathBuf {
    if let Some(dir) = &config.assets_dir {
        let sibling = dir.parent().map(|parent| parent.join("icons"));
        if let Some(sibling) = sibling {
            if sibling.exists() {
                return sibling;
            }
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/icons"))
}

// === Helpers ===

/// Run a blocking SQLite operation off the async runtime.
pub(crate) async fn db_query<T, F>(db: &Db, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
{
    let db = db.clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|_| "db mutex poisoned".to_string())?;
        f(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

#[allow(clippy::result_large_err)] // a ready-made Response keeps handlers flat
fn resolve_date(state: &AppState, date: Option<&str>) -> Result<String, Response> {
    match date.map(str::trim).filter(|d| !d.is_empty()) {
        None => Ok(today_local(state.config.timezone_offset_hours)),
        Some(value) if is_valid_date(value) => Ok(value.to_string()),
        Some(_) => Err(error_response(
            StatusCode::BAD_REQUEST,
            "date must be YYYY-MM-DD",
        )),
    }
}

fn config_view(config: &Config) -> ConfigView {
    ConfigView {
        base_url: config.base_url.clone(),
        concurrency_levels: config.concurrency_levels.clone(),
        requests_per_level: config.requests_per_level,
        test_runs: config.test_runs,
        questions_per_run: config.questions_per_run,
        max_tokens: config.max_tokens,
        output_tokens: config.effective_output_tokens(),
        input_tokens: config.input_tokens,
        stream_include_usage: config.stream_include_usage.to_string(),
        cache_bust: config.cache_bust,
        warmup_requests: config.warmup_count(),
        protocol_version: crate::config::PROTOCOL_VERSION.to_string(),
        request_timeout_secs: config.request_timeout_secs,
        timezone_offset_hours: config.timezone_offset_hours,
        scheduled: ScheduledView {
            hour: config.scheduled_hour,
            minute: config.scheduled_minute,
            cron_utc: config.cron_expression(),
        },
        models_cache_secs: config.models_cache_secs,
        cancel_supported: true,
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

async fn status_view(state: &AppState) -> StatusView {
    let status = state.test_status.lock().await.clone();
    let total = state.progress.total.load(Ordering::Relaxed);
    let completed = state.progress.completed.load(Ordering::Relaxed).min(total);

    let elapsed_secs = if status.running {
        state.progress.elapsed_secs()
    } else {
        status.elapsed_secs
    };

    // While requests are flowing the stored message ("Fetching models...")
    // would go stale, so compose a live one from the counters.
    let message = if status.running && total > 0 {
        Some(format!("Testing... {completed}/{total} requests"))
    } else {
        status.message
    };

    StatusView {
        running: status.running,
        cancel_requested: state.progress.is_cancelled() && status.running,
        message,
        progress: (total > 0).then_some(completed as f64 / total as f64),
        total_requests: (total > 0).then_some(total),
        completed_requests: (total > 0).then_some(completed),
        elapsed_secs,
        started_at: status.started_at,
        last_run: status.last_run,
        last_run_status: status.last_run_status,
        models: state.progress.snapshot(),
    }
}

fn best_of(models: &[DashboardModel]) -> BestSummary {
    let tested: Vec<&DashboardModel> = models.iter().filter(|m| m.tested).collect();
    let min_by = |pick: fn(&DashboardModel) -> Option<f64>| -> Option<BestEntry> {
        tested
            .iter()
            .filter_map(|model| pick(model).map(|value| (model.id.clone(), value)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(model, value)| BestEntry { model, value })
    };
    let max_by = |pick: fn(&DashboardModel) -> Option<f64>| -> Option<BestEntry> {
        tested
            .iter()
            .filter_map(|model| pick(model).map(|value| (model.id.clone(), value)))
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(model, value)| BestEntry { model, value })
    };

    BestSummary {
        ttft: min_by(|m| m.summary.avg_ttft_ms),
        tps: max_by(|m| m.summary.avg_tps),
        output_speed: max_by(|m| m.summary.avg_output_speed_tps),
        success_rate: max_by(|m| m.summary.success_rate),
    }
}

async fn build_dashboard(state: &Arc<AppState>, date: &str) -> Result<DashboardResponse, String> {
    let today = today_local(state.config.timezone_offset_hours);

    let date_owned = date.to_string();
    let records = db_query(&state.db, move |conn| {
        db::get_records_by_date(conn, &date_owned)
    })
    .await?;
    let dates = db_query(&state.db, db::get_available_dates).await?;
    let run_log = db_query(&state.db, |conn| db::get_run_logs(conn, 10)).await?;
    let models_view = state
        .models_cache
        .view(&state.runner, false, state.config.timezone_offset_hours)
        .await;

    let mut grouped: BTreeMap<String, Vec<DailyTestRecord>> = BTreeMap::new();
    for record in &records {
        grouped
            .entry(record.model.clone())
            .or_default()
            .push(record.clone());
    }

    let mut models: Vec<DashboardModel> = grouped
        .iter()
        .map(|(id, recs)| {
            let mut summary = Summary::from_records(recs);
            summary.models = 1;
            summary.models_tested = 1;
            DashboardModel {
                id: id.clone(),
                icon: icons::icon_for(id).to_string(),
                tested: true,
                status: health_status(recs).to_string(),
                has_data: true,
                records: recs.clone(),
                summary,
            }
        })
        .collect();
    models.sort_by(|a, b| {
        a.summary
            .avg_ttft_ms
            .unwrap_or(f64::MAX)
            .total_cmp(&b.summary.avg_ttft_ms.unwrap_or(f64::MAX))
    });

    let mut untested: Vec<DashboardModel> = models_view
        .models
        .iter()
        .filter(|model| !grouped.contains_key(&model.id))
        .map(|model| DashboardModel {
            id: model.id.clone(),
            icon: icons::icon_for(&model.id).to_string(),
            tested: false,
            status: "none".to_string(),
            has_data: false,
            records: Vec::new(),
            summary: Summary::default(),
        })
        .collect();
    untested.sort_by(|a, b| a.id.cmp(&b.id));
    models.append(&mut untested);

    let mut summary = Summary::from_records(&records);
    summary.models = models.len();
    summary.models_tested = grouped.len();

    let status = status_view(state).await;

    Ok(DashboardResponse {
        date: date.to_string(),
        today,
        dates,
        best: best_of(&models),
        models,
        summary,
        status,
        config: config_view(&state.config),
        run_log,
    })
}

// === Pages ===

/// Main dashboard page. Renders the shell only; all data is fetched by the
/// browser from `/api/dashboard`, so a slow upstream cannot block the page and
/// the client can re-render without a full reload.
async fn dashboard(State(state): State<Arc<AppState>>) -> Response {
    let today = today_local(state.config.timezone_offset_hours);
    render_page(&state, "dashboard.html", "dashboard", None, &today)
}

async fn history_page(
    State(state): State<Arc<AppState>>,
    AxumPath(date): AxumPath<String>,
) -> Response {
    if !is_valid_date(&date) {
        return error_response(StatusCode::BAD_REQUEST, "date must be YYYY-MM-DD");
    }
    let today = today_local(state.config.timezone_offset_hours);
    render_page(&state, "history.html", "history", Some(&date), &today)
}

fn render_page(
    state: &AppState,
    template: &str,
    page: &str,
    selected: Option<&str>,
    today: &str,
) -> Response {
    let tmpl = match state.template_env.get_template(template) {
        Ok(tmpl) => tmpl,
        Err(error) => {
            error!(error = %error, template, "Template not found");
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "template missing");
        }
    };
    let context = minijinja::context! {
        page => page,
        date => selected.unwrap_or_default(),
        selected_date => selected,
        today => today,
        version => env!("CARGO_PKG_VERSION"),
        base_url => state.config.base_url.clone(),
    };
    match tmpl.render(context) {
        Ok(rendered) => Html(rendered).into_response(),
        Err(error) => {
            error!(error = %error, template, "Template render failed");
            error_response(StatusCode::INTERNAL_SERVER_ERROR, "template render failed")
        }
    }
}

// === API Handlers ===

async fn api_dashboard(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DashboardQuery>,
) -> Response {
    let date = match resolve_date(&state, query.date.as_deref()) {
        Ok(date) => date,
        Err(response) => return response,
    };
    match build_dashboard(&state, &date).await {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => {
            error!(error = %error, "Failed to build dashboard payload");
            error_response(StatusCode::INTERNAL_SERVER_ERROR, error)
        }
    }
}

async fn api_today(State(state): State<Arc<AppState>>) -> Response {
    let date = today_local(state.config.timezone_offset_hours);
    let date_owned = date.clone();
    match db_query(&state.db, move |conn| {
        db::get_records_by_date(conn, &date_owned)
    })
    .await
    {
        Ok(records) => Json(records).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn api_history(
    State(state): State<Arc<AppState>>,
    AxumPath(date): AxumPath<String>,
) -> Response {
    if !is_valid_date(&date) {
        return error_response(StatusCode::BAD_REQUEST, "date must be YYYY-MM-DD");
    }
    match db_query(&state.db, move |conn| db::get_records_by_date(conn, &date)).await {
        Ok(records) => Json(records).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn api_dates(State(state): State<Arc<AppState>>) -> Response {
    match db_query(&state.db, db::get_available_dates).await {
        Ok(dates) => Json(dates).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn api_status(State(state): State<Arc<AppState>>) -> Json<StatusView> {
    Json(status_view(&state).await)
}

async fn api_config(State(state): State<Arc<AppState>>) -> Json<ConfigView> {
    Json(config_view(&state.config))
}

async fn api_models(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ModelsQuery>,
) -> Json<ModelsView> {
    let refresh = matches!(
        query.refresh.as_deref().map(str::trim),
        Some("1") | Some("true") | Some("yes")
    );
    Json(
        state
            .models_cache
            .view(&state.runner, refresh, state.config.timezone_offset_hours)
            .await,
    )
}

async fn api_trend(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TrendQuery>,
) -> Response {
    let metric = query.metric.as_deref().unwrap_or("ttft").trim().to_string();
    let column = match db::trend_column(&metric) {
        Some(column) => column,
        None => {
            return error_response(
                StatusCode::BAD_REQUEST,
                format!(
                    "unknown metric '{metric}', expected one of ttft,p50,p95,p99,tps,output,success"
                ),
            )
        }
    };
    if matches!(query.concurrency, Some(0)) {
        return error_response(StatusCode::BAD_REQUEST, "concurrency must be >= 1");
    }
    let model = query.model.trim().to_string();
    if model.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "model is required");
    }

    let concurrency = query.concurrency;
    let model_for_query = model.clone();
    let points = match db_query(&state.db, move |conn| {
        db::get_trend(conn, &model_for_query, column, concurrency)
    })
    .await
    {
        Ok(points) => points,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
    };

    Json(TrendResponse {
        model,
        metric,
        concurrency,
        points,
    })
    .into_response()
}

async fn api_run_log(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RunLogQuery>,
) -> Response {
    let limit = query.limit.unwrap_or(20).clamp(1, 200);
    match db_query(&state.db, move |conn| db::get_run_logs(conn, limit)).await {
        Ok(entries) => Json(entries).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn api_export_csv(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ExportQuery>,
) -> Response {
    let date = match resolve_date(&state, query.date.as_deref()) {
        Ok(date) => date,
        Err(response) => return response,
    };
    let model = query
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string);

    let date_for_query = date.clone();
    let model_for_query = model.clone();
    let records = match db_query(&state.db, move |conn| {
        let mut records = db::get_records_by_date(conn, &date_for_query)?;
        if let Some(model) = &model_for_query {
            records.retain(|record| &record.model == model);
        }
        Ok(records)
    })
    .await
    {
        Ok(records) => records,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
    };

    let mut body = String::from(
        "date,model,concurrency,request_count,error_count,success_rate,avg_ttft_ms,\
         min_ttft_ms,p50_ttft_ms,p95_ttft_ms,p99_ttft_ms,max_ttft_ms,\
         avg_output_speed_tps,avg_tps,total_tokens,total_duration_secs,created_at\n",
    );
    for record in &records {
        body.push_str(&format!(
            "{},{},{},{},{},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{:.3},{},{:.3},{}\n",
            csv_cell(&record.test_date),
            csv_cell(&record.model),
            record.concurrency,
            record.request_count,
            record.error_count,
            record.success_rate,
            record.avg_ttft_ms,
            record.min_ttft_ms,
            record.p50_ttft_ms,
            record.p95_ttft_ms,
            record.p99_ttft_ms,
            record.max_ttft_ms,
            record.avg_output_speed_tps,
            record.avg_tps,
            record.total_tokens,
            record.total_duration_secs,
            csv_cell(&record.created_at),
        ));
    }

    let filename = match &model {
        Some(model) => format!(
            "quanheng-bench-{}-{}.csv",
            date,
            sanitize_filename_component(model)
        ),
        None => format!("quanheng-bench-{date}.csv"),
    };

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        body,
    )
        .into_response()
}

fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn sanitize_filename_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

/// Trigger a full test run. Returns `false` when a run is already in flight.
async fn api_run_test(State(state): State<Arc<AppState>>) -> Response {
    match start_test(state, None).await {
        Ok(()) => (
            StatusCode::ACCEPTED,
            Json(json!({"message": "Test started"})),
        )
            .into_response(),
        Err(message) => error_response(StatusCode::CONFLICT, message),
    }
}

async fn api_run_model(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RunModelRequest>,
) -> Response {
    let model = request.model.trim().to_string();
    if model.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "model is required");
    }
    match start_test(state, Some(model)).await {
        Ok(()) => (
            StatusCode::ACCEPTED,
            Json(json!({"message": "Model test started"})),
        )
            .into_response(),
        Err(message) => error_response(StatusCode::CONFLICT, message),
    }
}

async fn api_cancel(State(state): State<Arc<AppState>>) -> Response {
    if !state.run_active.load(Ordering::SeqCst) {
        return error_response(StatusCode::CONFLICT, "no test running");
    }
    state.progress.request_cancel();
    {
        let mut status = state.test_status.lock().await;
        status.message = Some("Cancelling after the in-flight requests finish...".to_string());
    }
    (
        StatusCode::ACCEPTED,
        Json(json!({"message": "cancel requested"})),
    )
        .into_response()
}

/// Claim the single-run slot and start the background task.
pub async fn start_test(state: Arc<AppState>, model: Option<String>) -> Result<(), String> {
    if state
        .run_active
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("test already running".to_string());
    }

    let message = match &model {
        Some(model) => format!("Testing model {model}..."),
        None => "Fetching models...".to_string(),
    };
    {
        let mut status = state.test_status.lock().await;
        *status = TestStatus {
            running: true,
            progress: Some(0.0),
            total_requests: None,
            completed_requests: None,
            message: Some(message),
            last_run: status.last_run.clone(),
            last_run_status: status.last_run_status.clone(),
            elapsed_secs: None,
            started_at: Some(local_now(state.config.timezone_offset_hours)),
        };
    }
    state.progress.reset();

    tokio::spawn(async move {
        run_test_task(state, model).await;
    });
    Ok(())
}

/// Releases the single-run slot even if the task panics.
struct RunSlotGuard(Arc<AppState>);

impl Drop for RunSlotGuard {
    fn drop(&mut self) {
        self.0.run_active.store(false, Ordering::SeqCst);
    }
}

/// Background test runner — owns the run lifecycle, run log and status updates.
async fn run_test_task(state: Arc<AppState>, model: Option<String>) {
    let _slot = RunSlotGuard(state.clone());
    let tz = state.config.timezone_offset_hours;
    let started_at = local_now(tz);
    let started = Instant::now();
    let mode = if model.is_some() { "model" } else { "full" };

    let log_id = {
        let db = state.db.clone();
        let started_at = started_at.clone();
        let target = model.clone();
        db_query(&db, move |conn| {
            db::insert_run_log(conn, &started_at, mode, target.as_deref())
        })
        .await
        .ok()
    };

    let result = match &model {
        Some(model) => {
            state
                .runner
                .run_model_test(model, state.progress.clone())
                .await
        }
        None => state.runner.run_full_test(state.progress.clone()).await,
    };

    let cancelled = state.progress.is_cancelled();
    let elapsed_secs = started.elapsed().as_secs_f64();
    let (status_text, message, record_count) = match &result {
        Ok(records) if cancelled => (
            "cancelled",
            format!("Test cancelled after {} records", records.len()),
            records.len(),
        ),
        Ok(records) => {
            let failed: usize = records.iter().map(|record| record.error_count).sum();
            let message = if failed > 0 {
                format!(
                    "Test completed: {} records saved, {} requests failed",
                    records.len(),
                    failed
                )
            } else {
                format!("Test completed: {} records saved", records.len())
            };
            ("success", message, records.len())
        }
        Err(error) => ("failed", format!("Test failed: {error}"), 0),
    };

    {
        let mut status = state.test_status.lock().await;
        status.running = false;
        status.progress = Some(1.0);
        status.message = Some(message.clone());
        status.last_run = Some(local_now(tz));
        status.last_run_status = Some(match status_text {
            "success" => "success".to_string(),
            "cancelled" => "cancelled".to_string(),
            _ => format!(
                "failed: {}",
                result.as_ref().err().cloned().unwrap_or_default()
            ),
        });
        status.elapsed_secs = Some(elapsed_secs);
    }

    if let Some(log_id) = log_id {
        let db = state.db.clone();
        let finished_at = local_now(tz);
        let status_text = status_text.to_string();
        let message = message.clone();
        let _ = db_query(&db, move |conn| {
            db::finish_run_log(
                conn,
                log_id,
                &status_text,
                &message,
                record_count,
                &finished_at,
                elapsed_secs,
            )
        })
        .await;
    }

    match &result {
        Ok(records) => info!(
            status = status_text,
            records = records.len(),
            elapsed_secs,
            "Test run finished"
        ),
        Err(error) => error!(error = %error, "Test run failed"),
    }

    state.run_active.store(false, Ordering::SeqCst);
}

/// Templates embedded at build time by `build.rs` (name -> source).
mod embedded_templates {
    include!(concat!(env!("OUT_DIR"), "/embedded_templates.rs"));
}

/// Initialize the template environment with embedded templates.
///
/// Every file under `templates/` is embedded in the binary, so a single-file
/// deployment works without shipping the directory. Registration is generated
/// by `build.rs`: minijinja has no filesystem loader, so `{% extends %}` and
/// `{% include %}` can only resolve names that were registered up front.
pub fn init_templates() -> Environment<'static> {
    let mut env = Environment::new();
    env.add_function("icon_for", icons::icon_for);

    for (name, source) in embedded_templates::EMBEDDED_TEMPLATES {
        env.add_template_owned(*name, (*source).to_string())
            .unwrap_or_else(|error| panic!("Failed to add template {name}: {error}"));
    }

    let available: Vec<&str> = embedded_templates::EMBEDDED_TEMPLATES
        .iter()
        .map(|(name, _)| *name)
        .collect();
    for required in ["dashboard.html", "history.html"] {
        assert!(
            available.contains(&required),
            "templates/ is missing {required}; embedded templates: {available:?}"
        );
    }

    env
}

/// Ensure the run log never keeps a stale `running` row after a restart.
pub fn mark_stale_runs_on_boot(db: &Db, tz_offset: i32) {
    let now = local_now(tz_offset);
    let guard = db.lock();
    match guard {
        Ok(conn) => {
            if let Err(error) = db::mark_stale_runs(&conn, &now) {
                warn!(error = %error, "Failed to mark stale runs");
            }
        }
        Err(_) => warn!("DB mutex poisoned while marking stale runs"),
    }
}

/// Convenience used by the scheduler / startup path.
pub async fn trigger_scheduled(state: Arc<AppState>) {
    if let Err(message) = start_test(state, None).await {
        info!(reason = %message, "Scheduled run skipped");
    }
}

#[cfg(test)]
mod tests {
    use super::{csv_cell, sanitize_filename_component};

    #[test]
    fn csv_cells_are_quoted_only_when_needed() {
        assert_eq!(csv_cell("plain-model"), "plain-model");
        assert_eq!(csv_cell("model,with,comma"), "\"model,with,comma\"");
        assert_eq!(csv_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell("line\nbreak"), "\"line\nbreak\"");
    }

    #[test]
    fn download_filenames_never_escape_the_header() {
        assert_eq!(sanitize_filename_component("Qwen3.8-27B"), "Qwen3.8-27B");
        assert_eq!(
            sanitize_filename_component("a/b\"c\n"),
            "a_b_c_",
            "path separators, quotes and newlines become underscores"
        );
    }
}
