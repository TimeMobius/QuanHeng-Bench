use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use axum::Router;
use tokio::signal;
use tokio_cron_scheduler::{Job, JobScheduler};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

mod config;
mod db;
mod icons;
mod models;
mod questions;
mod routes;
mod tester;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,quanheng_bench=debug")),
        )
        .json()
        .init();

    let config = Arc::new(config::Config::from_env());
    info!(
        base_url = %config.base_url,
        host = %config.host,
        port = config.port,
        db_path = %config.db_path.display(),
        cron = %config.cron_expression(),
        requests_per_level = config.requests_per_level,
        concurrency_levels = ?config.concurrency_levels,
        protocol_version = config::PROTOCOL_VERSION,
        "Configuration loaded"
    );

    let db_conn = db::init_db(&config.db_path, config.timezone_offset_hours).unwrap_or_else(|e| {
        error!(error = %e, "Failed to initialize database");
        panic!("Database initialization failed: {}", e);
    });
    info!("Database initialized at {}", config.db_path.display());
    let db = db::shared(db_conn);
    routes::mark_stale_runs_on_boot(&db, config.timezone_offset_hours);

    let runner = tester::TestRunner::new(config.clone(), db.clone());
    let progress = Arc::new(tester::RunProgress::new());

    let state = Arc::new(routes::AppState {
        config: config.clone(),
        db: db.clone(),
        runner,
        progress,
        test_status: tokio::sync::Mutex::new(models::TestStatus::default()),
        template_env: routes::init_templates(),
        models_cache: routes::ModelsCache::new(std::time::Duration::from_secs(
            config.models_cache_secs,
        )),
        run_active: AtomicBool::new(false),
    });

    let app = build_app(state.clone());

    let addr = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| {
            error!(error = %e, addr = %addr, "Failed to bind address");
            panic!("Failed to bind to {}: {}", addr, e);
        });

    info!("Server listening on http://{}", addr);

    // Start cron scheduler for daily scheduled tests
    let cron_expr = config.cron_expression();
    let cron_state = state.clone();
    tokio::spawn(async move {
        let sched = match JobScheduler::new().await {
            Ok(s) => s,
            Err(e) => {
                error!(error = %e, "Failed to create scheduler");
                return;
            }
        };

        let job_state = cron_state.clone();
        let job = match Job::new_async(cron_expr.as_str(), move |_uuid, _lock| {
            let js = job_state.clone();
            Box::pin(async move {
                info!("Scheduled test triggered at {:?}", chrono::Utc::now());
                routes::trigger_scheduled(js).await;
            })
        }) {
            Ok(j) => j,
            Err(e) => {
                error!(error = %e, "Failed to create cron job");
                return;
            }
        };

        if let Err(e) = sched.add(job).await {
            error!(error = %e, "Failed to add cron job");
            return;
        }

        if let Err(e) = sched.start().await {
            error!(error = %e, "Failed to start scheduler");
        }
    });

    // Run an initial test when today has no data yet (opt-out with RUN_ON_START=false)
    let today = models::today_local(config.timezone_offset_hours);
    let today_for_query = today.clone();
    let should_run_initial = config.run_on_start
        && routes::db_query(&db, move |conn| {
            db::get_records_by_date(conn, &today_for_query)
        })
        .await
        .map(|records| records.is_empty())
        .unwrap_or(false);

    if should_run_initial {
        info!("No data for today, running initial test...");
        let init_state = state.clone();
        tokio::spawn(async move {
            routes::trigger_scheduled(init_state).await;
        });
    } else if !config.run_on_start {
        info!("RUN_ON_START disabled, skipping initial test");
    } else {
        info!("Data exists for today, skipping initial test");
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap_or_else(|e| {
            error!(error = %e, "Server error");
        });
}

fn build_app(state: Arc<routes::AppState>) -> Router {
    let router = Router::new()
        .merge(routes::build_router(state.clone()))
        .layer(axum::middleware::from_fn(hardening_headers))
        .layer(TraceLayer::new_for_http());

    match cors_layer(&state.config) {
        Some(cors) => router.layer(cors),
        None => router,
    }
}

/// Baseline response hardening (CSP is intentionally omitted: the theme boot
/// script is inline by design, and a strict policy would need a nonce).
///
/// Also sets cache directives: browsers apply heuristic caching to responses
/// that only carry `Last-Modified`, which made an upgraded instance keep
/// serving the old JS/CSS. App assets must revalidate; vendored libraries and
/// icons are immutable enough to cache for a week; API responses never cache.
async fn hardening_headers(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;

    let cache_control = if path.starts_with("/assets/vendor/") || path.starts_with("/icons/") {
        Some("public, max-age=604800")
    } else if path.starts_with("/assets/") {
        Some("no-cache")
    } else if path.starts_with("/api/") {
        Some("no-store")
    } else {
        None
    };
    if let Some(directive) = cache_control {
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static(directive),
        );
    }

    let headers = response.headers_mut();
    headers
        .entry(axum::http::header::X_CONTENT_TYPE_OPTIONS)
        .or_insert(axum::http::HeaderValue::from_static("nosniff"));
    headers
        .entry(axum::http::header::REFERRER_POLICY)
        .or_insert(axum::http::HeaderValue::from_static("no-referrer"));
    headers
        .entry(axum::http::header::X_FRAME_OPTIONS)
        .or_insert(axum::http::HeaderValue::from_static("DENY"));
    response
}

/// CORS is opt-in.
///
/// The previous build used `allow_origin(Any)` on every route, which let any
/// website trigger `POST /api/run-test` against a reachable instance. With
/// `CORS_ORIGINS` unset the browser only allows same-origin requests.
fn cors_layer(config: &config::Config) -> Option<CorsLayer> {
    if config.cors_origins.is_empty() {
        return None;
    }
    let layer = CorsLayer::new();
    if config.cors_origins.iter().any(|origin| origin == "*") {
        return Some(
            layer
                .allow_origin(Any)
                .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
                .allow_headers(Any),
        );
    }

    let origins: Vec<axum::http::HeaderValue> = config
        .cors_origins
        .iter()
        .filter_map(|origin| origin.parse().ok())
        .collect();
    Some(
        layer
            .allow_origin(origins)
            .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
            .allow_headers([
                axum::http::header::CONTENT_TYPE,
                axum::http::header::AUTHORIZATION,
            ]),
    )
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => { info!("Received Ctrl+C, shutting down..."); }
        _ = terminate => { info!("Received SIGTERM, shutting down..."); }
    }
}
