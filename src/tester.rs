use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures::TryStreamExt;
use reqwest::Client;
use tracing::{debug, error, info, warn};

use crate::config::{Config, UsageMode, PROTOCOL_VERSION};
use crate::db::{self, Db};
use crate::models::*;
use crate::questions;

/// How often an in-flight request re-checks the cancel flag while waiting.
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Upper bound for the model list fetch at the start of a run.
const MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// Rough chars-per-token used to pad/truncate prompts to the input budget.
/// The question bank is English; exact sizing needs a tokenizer (P1).
const CHARS_PER_TOKEN: usize = 4;

/// Filler paragraph used to pad short questions up to the input budget.
const FILLER: &str = "The quick brown fox jumps over the lazy dog near the riverbank, \
where willow trees lean toward the morning mist and the water keeps the memory of \
every storm. A ferryman counts the boats, the crows count the boats back, and the \
bridge remembers each pair of shoes that ever crossed it in a hurry. Somewhere down \
stream the mill turns slowly, and the meadow keeps its own quiet ledger of rain.";

/// Process-wide negotiated capability: does this endpoint answer
/// `stream_options.include_usage` with a usage frame? Set at most once per
/// process (the endpoint is fixed by configuration), so later runs skip the
/// probe and reuse the cached answer — which is also persisted in
/// `endpoint_capabilities` for inspection across restarts.
static USAGE_CELL: Mutex<Option<bool>> = Mutex::new(None);

fn usage_cell_get() -> Option<bool> {
    *USAGE_CELL.lock().unwrap()
}

fn usage_cell_set(value: bool) {
    *USAGE_CELL.lock().unwrap() = Some(value);
}

/// Per-run resolution of the usage capability (protocol v2-A).
///
/// Locked once before the first batch is dispatched: `On`/`Off` straight from
/// config, `Auto` via the once-per-run probe.
#[derive(Clone)]
pub struct UsagePlan {
    run_value: Arc<AtomicBool>,
}

impl UsagePlan {
    pub fn new() -> Self {
        Self {
            run_value: Arc::new(AtomicBool::new(false)),
        }
    }

    fn lock(&self, value: bool) {
        self.run_value.store(value, Ordering::Relaxed);
    }

    /// Whether the next request should send `stream_options.include_usage`.
    /// False until locked (never true before `prepare_usage` completes, so the
    /// safe no-field path is the only pre-decision behavior).
    pub fn value(&self) -> bool {
        self.run_value.load(Ordering::Relaxed)
    }
}

/// Build the prompt body for one request: the bank question padded or
/// truncated toward the input budget (in tokens). `input_tokens == 0` keeps
/// the question as-is (v1 behavior).
fn build_prompt(question: &str, input_tokens: u32) -> String {
    if input_tokens == 0 {
        return question.to_string();
    }
    let target_chars = input_tokens as usize * CHARS_PER_TOKEN;
    let chars: Vec<char> = question.chars().collect();
    if chars.len() >= target_chars {
        chars[..target_chars].iter().collect()
    } else {
        let mut body: String = chars.iter().collect();
        while body.chars().count() < target_chars {
            body.push_str(FILLER);
        }
        body.chars().take(target_chars).collect()
    }
}

static NONCE_EPOCH: OnceLock<i64> = OnceLock::new();
static NONCE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Per-request unique head marker. Prefix KV caches match from the start of
/// the sequence, so a different head invalidates reuse of the whole prompt —
/// the nonce MUST stay at the head (a trailing marker would leave the long
/// shared prefix cached and would not defeat the cache).
fn next_nonce() -> String {
    let epoch = *NONCE_EPOCH.get_or_init(|| chrono::Utc::now().timestamp());
    let seq = NONCE_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("qh-{epoch}-{seq:08x}")
}

/// Final prompt for one request under the configured protocol:
/// budget sizing first, then the cache-bust nonce at the head.
fn prompt_for_request(question: &str, config: &Config) -> String {
    let body = build_prompt(question, config.input_tokens);
    if config.cache_bust {
        format!("# {}\n{}", next_nonce(), body)
    } else {
        body
    }
}

/// Per-model progress bucket, shared with the status endpoint.
pub struct ModelProgress {
    pub total: AtomicUsize,
    pub completed: AtomicUsize,
    status: AtomicU8,
}

/// Model status codes.
pub const MODEL_PENDING: u8 = 0;
pub const MODEL_RUNNING: u8 = 1;
pub const MODEL_DONE: u8 = 2;
pub const MODEL_ERROR: u8 = 3;

impl ModelProgress {
    fn new(total: usize) -> Self {
        ModelProgress {
            total: AtomicUsize::new(total),
            completed: AtomicUsize::new(0),
            status: AtomicU8::new(MODEL_PENDING),
        }
    }

    fn status_name(&self) -> &'static str {
        match self.status.load(Ordering::Relaxed) {
            MODEL_RUNNING => "running",
            MODEL_DONE => "done",
            MODEL_ERROR => "error",
            _ => "pending",
        }
    }
}

/// Shared progress for one run (global counters + per-model buckets + cancel flag).
pub struct RunProgress {
    pub total: AtomicUsize,
    pub completed: AtomicUsize,
    pub cancel: Arc<AtomicBool>,
    started_at: Mutex<Option<Instant>>,
    models: Mutex<BTreeMap<String, Arc<ModelProgress>>>,
}

impl Default for RunProgress {
    fn default() -> Self {
        Self::new()
    }
}

impl RunProgress {
    pub fn new() -> Self {
        Self {
            total: AtomicUsize::new(0),
            completed: AtomicUsize::new(0),
            cancel: Arc::new(AtomicBool::new(false)),
            started_at: Mutex::new(None),
            models: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn reset(&self) {
        self.total.store(0, Ordering::Relaxed);
        self.completed.store(0, Ordering::Relaxed);
        self.cancel.store(false, Ordering::Relaxed);
        *self.started_at.lock().unwrap() = None;
        self.models.lock().unwrap().clear();
    }

    /// Register the model plan for a run and start the clock.
    ///
    /// Note: this must NOT clear the cancel flag. A cancel request can arrive
    /// while the run is still fetching the model list, i.e. before the plan is
    /// known; clearing it here would silently swallow that request.
    pub fn begin(&self, plan: &[(String, usize)]) {
        self.completed.store(0, Ordering::Relaxed);
        let mut total = 0usize;
        let mut models = self.models.lock().unwrap();
        for (name, requests) in plan {
            total += requests;
            models.insert(name.clone(), Arc::new(ModelProgress::new(*requests)));
        }
        drop(models);
        self.total.store(total, Ordering::Relaxed);
        *self.started_at.lock().unwrap() = Some(Instant::now());
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn request_cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    pub fn elapsed_secs(&self) -> Option<f64> {
        self.started_at
            .lock()
            .unwrap()
            .map(|start| start.elapsed().as_secs_f64())
    }

    pub fn model_progress(&self, model: &str) -> Option<Arc<ModelProgress>> {
        self.models.lock().unwrap().get(model).cloned()
    }

    pub fn set_model_status(&self, model: &str, status: u8) {
        if let Some(progress) = self.model_progress(model) {
            progress.status.store(status, Ordering::Relaxed);
        }
    }

    /// Progress marker for a request that could not be attributed to a model bucket.
    pub fn mark_completed(&self) {
        self.completed.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> Vec<ModelProgressView> {
        self.models
            .lock()
            .unwrap()
            .iter()
            .map(|(name, progress)| ModelProgressView {
                name: name.clone(),
                total: progress.total.load(Ordering::Relaxed),
                completed: progress
                    .completed
                    .load(Ordering::Relaxed)
                    .min(progress.total.load(Ordering::Relaxed)),
                status: progress.status_name().to_string(),
            })
            .collect()
    }
}

/// Shared test state
pub struct TestRunner {
    pub client: Client,
    pub config: Arc<Config>,
    pub db: Db,
}

/// Everything needed to issue one request (owned so it can be moved into a task).
#[derive(Clone)]
struct RequestSpec {
    url: String,
    api_key: Option<String>,
    model: String,
    question: String,
    max_tokens: u32,
    concurrency: usize,
    include_usage: bool,
}

impl TestRunner {
    pub fn new(config: Arc<Config>, db: Db) -> Self {
        let client = Client::builder()
            .user_agent(concat!("QuanHeng-Bench/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(config.request_timeout_secs))
            .pool_max_idle_per_host(64)
            .build()
            .expect("Failed to create HTTP client");

        TestRunner { client, config, db }
    }

    /// Fetch model list from /v1/models
    pub async fn fetch_models(&self) -> Result<Vec<ModelInfo>, String> {
        let url = format!("{}/v1/models", self.config.base_url);
        debug!(url = %url, "Fetching models");

        let response = self
            .client
            .get(&url)
            .header("Content-Type", "application/json")
            .optional_auth(&self.config.api_key)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch models: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("Models API returned {}: {}", status, body));
        }

        let models_response: ModelsResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse models response: {}", e))?;

        Ok(models_response.data)
    }

    /// Resolve the usage capability for this run (protocol v2-A) and return
    /// the plan that every request of the run follows.
    pub async fn prepare_usage(&self, probe_model: &str) -> UsagePlan {
        let plan = UsagePlan::new();
        match self.config.stream_include_usage {
            UsageMode::On => plan.lock(true),
            UsageMode::Off => plan.lock(false),
            UsageMode::Auto => match self.negotiate_usage(probe_model).await {
                Some(value) => plan.lock(value),
                // Transient probe failure (5xx/timeout): send no field this
                // run (the safe path) and keep the capability un-persisted so
                // the next run re-probes.
                None => plan.lock(false),
            },
        }
        plan
    }

    /// One-time capability negotiation for `Auto` mode: process cache → DB
    /// cache → a single cheap probe (`max_tokens: 1`, asking for usage).
    ///
    /// Returns `None` (inconclusive) only when the probe itself failed
    /// transiently; a 4xx means the gateway rejected the unknown field, which
    /// is a definitive "unsupported".
    async fn negotiate_usage(&self, probe_model: &str) -> Option<bool> {
        if let Some(value) = usage_cell_get() {
            return Some(value);
        }

        let db = self.db.clone();
        let base_url = self.config.base_url.clone();
        let cached: Option<bool> = tokio::task::spawn_blocking(move || -> Option<bool> {
            let conn = db.lock().ok()?;
            db::load_endpoint_capability(&conn, &base_url)
                .ok()
                .flatten()
        })
        .await
        .ok()
        .flatten();
        if let Some(value) = cached {
            usage_cell_set(value);
            return Some(value);
        }

        let spec = RequestSpec {
            url: format!("{}/v1/chat/completions", self.config.base_url),
            api_key: self.config.api_key.clone(),
            model: probe_model.to_string(),
            question: "Reply with exactly one word: ok".to_string(),
            max_tokens: 1,
            concurrency: 1,
            include_usage: true,
        };
        let no_cancel = Arc::new(AtomicBool::new(false));
        let result = Self::run_single_attempt(&self.client, &spec, &no_cancel).await;

        if result.success {
            let value = result.used_usage;
            self.persist_capability(value).await;
            usage_cell_set(value);
            info!(supports_usage = value, "usage capability negotiated");
            return Some(value);
        }

        if let Some(code) = http_status_from_error(result.error.as_deref()) {
            if (400..500).contains(&code) {
                self.persist_capability(false).await;
                usage_cell_set(false);
                info!(
                    status = code,
                    "usage capability: gateway rejected stream_options"
                );
                return Some(false);
            }
        }
        None
    }

    async fn persist_capability(&self, supports: bool) {
        let db = self.db.clone();
        let base_url = self.config.base_url.clone();
        match tokio::task::spawn_blocking(move || -> Result<(), String> {
            let conn = db.lock().map_err(|_| "db mutex poisoned".to_string())?;
            db::upsert_endpoint_capability(&conn, &base_url, supports).map_err(|e| e.to_string())
        })
        .await
        {
            Ok(Ok(())) => {}
            _ => warn!("Failed to persist endpoint capability"),
        }
    }

    /// Run a single request against the chat/completion endpoint and measure TTFT + TPS.
    /// Retries up to 3 attempts on transient failures (gateway 5xx, stream errors).
    async fn run_single_api_request(
        client: Client,
        spec: RequestSpec,
        cancel: Arc<AtomicBool>,
    ) -> RequestResult {
        const MAX_ATTEMPTS: usize = 3;

        let mut last_result = None;
        for attempt in 1..=MAX_ATTEMPTS {
            if cancel.load(Ordering::Relaxed) {
                return RequestResult::cancelled(&spec.model, spec.concurrency);
            }

            let result = Self::run_single_attempt(&client, &spec, &cancel).await;
            if result.success || result.cancelled {
                return result;
            }

            let retriable = result
                .error
                .as_deref()
                .map(should_retry_error)
                .unwrap_or(false);

            if attempt < MAX_ATTEMPTS && retriable {
                let delay = Duration::from_millis(500 * attempt as u64);
                warn!(
                    model = %spec.model, concurrency = spec.concurrency,
                    attempt = attempt, error = %result.error.as_deref().unwrap_or("unknown"),
                    retry_after_ms = delay.as_millis(),
                    "Retrying request"
                );
                tokio::time::sleep(delay).await;
                last_result = Some(result);
            } else {
                return result;
            }
        }

        last_result.unwrap_or_else(|| {
            RequestResult::failure(
                &spec.model,
                spec.concurrency,
                0.0,
                "All retry attempts exhausted",
            )
        })
    }

    /// Single attempt (no retry) — returns a RequestResult
    async fn run_single_attempt(
        client: &Client,
        spec: &RequestSpec,
        cancel: &Arc<AtomicBool>,
    ) -> RequestResult {
        let payload = ChatRequest {
            model: spec.model.clone(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: "You are a helpful assistant. Provide detailed, thorough responses."
                        .to_string(),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: spec.question.clone(),
                },
            ],
            max_tokens: spec.max_tokens,
            stream: true,
            stream_options: spec.include_usage.then_some(StreamOptions {
                include_usage: true,
            }),
        };

        let start = Instant::now();
        let mut stats = StreamStats::default();

        // Waiting for the response head must also be cancellable: a stuck
        // upstream would otherwise keep a run alive for the whole timeout.
        let send_future = client
            .post(&spec.url)
            .header("Content-Type", "application/json")
            .optional_auth(&spec.api_key)
            .json(&payload)
            .send();
        tokio::pin!(send_future);
        let response = loop {
            tokio::select! {
                result = &mut send_future => break result,
                _ = tokio::time::sleep(CANCEL_POLL_INTERVAL) => {
                    if cancel.load(Ordering::Relaxed) {
                        return RequestResult::cancelled(&spec.model, spec.concurrency);
                    }
                }
            }
        };
        let response = match response {
            Ok(r) => r,
            Err(e) => {
                if cancel.load(Ordering::Relaxed) {
                    return RequestResult::cancelled(&spec.model, spec.concurrency);
                }
                warn!(model = %spec.model, concurrency = spec.concurrency, error = %e, "Request failed");
                return RequestResult::failure(
                    &spec.model,
                    spec.concurrency,
                    start.elapsed().as_secs_f64() * 1000.0,
                    format!("Request failed: {}", e),
                );
            }
        };

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            warn!(model = %spec.model, concurrency = spec.concurrency, status = %status, body = %body, "HTTP error response");
            return RequestResult::failure(
                &spec.model,
                spec.concurrency,
                0.0,
                format!("HTTP {}: {}", status, body),
            );
        }

        // Process streaming response. Chunks are buffered per line: an SSE line
        // may be split across two network chunks, and parsing the raw chunk as
        // whole lines silently drops those records (undercounting tokens).
        let mut stream = response.bytes_stream();
        let mut buffer = SseLineBuffer::default();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return RequestResult::cancelled(&spec.model, spec.concurrency);
            }
            let next_chunk = tokio::time::timeout(CANCEL_POLL_INTERVAL, stream.try_next()).await;
            match next_chunk {
                Err(_elapsed) => {
                    // No data for one poll interval: re-check cancellation and
                    // keep waiting instead of aborting the stream.
                    continue;
                }
                Ok(Ok(Some(chunk))) => {
                    for line in buffer.push(&chunk) {
                        process_sse_line(&line, &mut stats, start);
                    }
                }
                Ok(Ok(None)) => {
                    if let Some(rest) = buffer.take_rest() {
                        process_sse_line(&rest, &mut stats, start);
                    }
                    break;
                }
                Ok(Err(e)) => {
                    if cancel.load(Ordering::Relaxed) {
                        return RequestResult::cancelled(&spec.model, spec.concurrency);
                    }
                    warn!(model = %spec.model, concurrency = spec.concurrency, error = %e, "Stream error");
                    return RequestResult::failure(
                        &spec.model,
                        spec.concurrency,
                        start.elapsed().as_secs_f64() * 1000.0,
                        format!("Stream error: {}", e),
                    );
                }
            }
        }

        // A 200 response can still be a failure: an SSE `error` frame, or an
        // empty stream (no content, no reasoning, no usage).
        if let Some(error) = stats.error.take() {
            if stats.content.is_empty() && stats.usage.is_none() {
                return RequestResult::failure(
                    &spec.model,
                    spec.concurrency,
                    0.0,
                    format!("Stream error frame: {error}"),
                );
            }
        }
        if stats.content.is_empty() && stats.usage.is_none() {
            return RequestResult::failure(
                &spec.model,
                spec.concurrency,
                0.0,
                "Empty stream response (no content or usage)",
            );
        }

        let total_duration = start.elapsed();
        let ttft_ms = stats
            .first_token
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(total_duration.as_secs_f64() * 1000.0);
        let generation_secs = (total_duration.as_secs_f64() - (ttft_ms / 1000.0)).max(0.001);

        let used_usage = stats.usage.is_some();
        let prompt_tokens = stats
            .usage
            .as_ref()
            .and_then(|u| u.prompt_tokens)
            .unwrap_or_else(|| estimate_tokens(&spec.question));
        let total_tokens = stats
            .usage
            .as_ref()
            .and_then(|u| u.completion_tokens)
            .unwrap_or_else(|| estimate_tokens(&stats.content));

        let tokens_per_second = total_tokens as f64 / total_duration.as_secs_f64().max(0.001);

        // If the server emitted no per-token cadence (first token == last token),
        // output speed and overall throughput describe the same thing.
        let output_speed_tps = if generation_secs >= 0.1 {
            total_tokens as f64 / generation_secs
        } else {
            tokens_per_second
        };

        RequestResult {
            model: spec.model.clone(),
            concurrency: spec.concurrency,
            ttft_ms,
            output_speed_tps,
            tokens_per_second,
            total_tokens,
            prompt_tokens,
            used_usage,
            single_request_ms: total_duration.as_secs_f64() * 1000.0,
            success: true,
            cancelled: false,
            error: None,
        }
    }

    /// Run performance test for a single model at a given concurrency level.
    ///
    /// Uses a worker-pool of exactly `concurrency` tasks pulling from a shared
    /// counter, so the in-flight request count matches the level and a cancel
    /// request takes effect immediately instead of after a whole batch.
    pub async fn test_model_concurrency(
        &self,
        model: &str,
        concurrency: usize,
        questions: &[String],
        progress: &Arc<RunProgress>,
        usage: &UsagePlan,
    ) -> AggregatedResult {
        let total_requests = self.config.requests_for_level(concurrency);
        // 这一档只跑测量请求。冷启动预热已在模型级的独立阶段完成
        // （见 `warmup_model`），因此墙钟与统计同口径。
        let test_start = Instant::now();
        let next = Arc::new(AtomicUsize::new(0));
        let questions = Arc::new(questions.to_vec());
        let model_progress = progress.model_progress(model);

        let base_spec = RequestSpec {
            url: format!("{}/v1/chat/completions", self.config.base_url),
            api_key: self.config.api_key.clone(),
            model: model.to_string(),
            question: String::new(),
            max_tokens: self.config.effective_output_tokens(),
            concurrency,
            include_usage: false, // resolved per request from the UsagePlan
        };

        let mut handles = Vec::new();
        for _ in 0..concurrency.min(total_requests).max(1) {
            let client = self.client.clone();
            let spec = base_spec.clone();
            let next = next.clone();
            let cancel = progress.cancel.clone();
            let questions = questions.clone();
            let model_progress = model_progress.clone();
            let progress = progress.clone();
            let config = self.config.clone();
            let usage = usage.clone();

            handles.push(tokio::spawn(async move {
                let mut results: Vec<(usize, RequestResult)> = Vec::new();
                loop {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    if index >= total_requests {
                        break;
                    }
                    let mut request = spec.clone();
                    let raw_question = if questions.is_empty() {
                        String::new()
                    } else {
                        questions[index % questions.len()].clone()
                    };
                    request.question = prompt_for_request(&raw_question, &config);
                    request.include_usage = usage.value();
                    let result =
                        Self::run_single_api_request(client.clone(), request, cancel.clone()).await;
                    if let Some(bucket) = &model_progress {
                        bucket.completed.fetch_add(1, Ordering::Relaxed);
                    }
                    progress.mark_completed();
                    results.push((index, result));
                }
                results
            }));
        }

        let mut all_indexed: Vec<(usize, RequestResult)> = Vec::new();
        for handle in handles {
            match handle.await {
                Ok(results) => all_indexed.extend(results),
                Err(e) => error!("Task join error: {}", e),
            }
        }
        let total_duration = test_start.elapsed();

        let mut measured_results: Vec<RequestResult> = Vec::new();
        let mut error_summary: BTreeMap<String, usize> = BTreeMap::new();
        let mut total_tokens: i64 = 0;
        let mut error_count = 0usize;
        let mut cancelled_count = 0usize;

        for (_index, result) in all_indexed {
            if result.success {
                total_tokens += result.total_tokens;
                measured_results.push(result);
            } else if result.cancelled {
                cancelled_count += 1;
            } else {
                error_count += 1;
                let summary = summarize_error(result.error.as_deref().unwrap_or("unknown error"));
                *error_summary.entry(summary).or_insert(0) += 1;
            }
        }

        let success_count = measured_results.len();
        let total_count = success_count + error_count + cancelled_count;
        let success_rate = if total_count > 0 {
            (success_count as f64 / total_count as f64) * 100.0
        } else {
            0.0
        };

        // Calculate percentiles for TTFT
        let mut ttft_values: Vec<f64> = measured_results.iter().map(|r| r.ttft_ms).collect();
        ttft_values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let avg_ttft = if !ttft_values.is_empty() {
            ttft_values.iter().sum::<f64>() / ttft_values.len() as f64
        } else {
            0.0
        };
        let min_ttft = ttft_values.first().copied().unwrap_or(0.0);
        let max_ttft = ttft_values.last().copied().unwrap_or(0.0);
        let p50_ttft = percentile(&ttft_values, 50.0);
        let p95_ttft = percentile(&ttft_values, 95.0);
        let p99_ttft = percentile(&ttft_values, 99.0);

        let avg_tps = mean(
            measured_results
                .iter()
                .map(|r| r.tokens_per_second)
                .collect::<Vec<_>>(),
        );
        let avg_output_speed = mean(
            measured_results
                .iter()
                .map(|r| r.output_speed_tps)
                .collect::<Vec<_>>(),
        );

        // Protocol v2 token provenance: a level measured with exact usage
        // frames is "usage", otherwise the numbers are character estimates.
        let input_tokens_avg = if success_count > 0 {
            measured_results
                .iter()
                .map(|r| r.prompt_tokens)
                .sum::<i64>() as f64
                / success_count as f64
        } else {
            0.0
        };
        let output_tokens_avg = if success_count > 0 {
            total_tokens as f64 / success_count as f64
        } else {
            0.0
        };
        let token_source = if measured_results.iter().any(|r| r.used_usage) {
            "usage".to_string()
        } else {
            "estimate".to_string()
        };

        let error_summary = top_errors(error_summary);

        info!(
            model = %model,
            concurrency = concurrency,
            success_rate = success_rate,
            error_count = error_count,
            cancelled = cancelled_count,
            avg_ttft_ms = avg_ttft,
            avg_tps = avg_tps,
            avg_output_speed_tps = avg_output_speed,
            "Model concurrency test completed"
        );

        // 饱和判定：把"整档墙钟"和"单请求实测墙钟"摆在一起。
        //
        // 若 concurrency 个请求真的并行，跑完一波的时间应该 ≈ 单请求时间；
        // 一旦实际墙钟明显更长，说明请求在排队，这个档位已经超过模型的有效并发。
        let single_request_ms = mean(
            measured_results
                .iter()
                .map(|r| r.single_request_ms)
                .collect::<Vec<_>>(),
        );
        let wave_count = if concurrency > 0 {
            total_requests as f64 / concurrency as f64
        } else {
            0.0
        };
        let saturation_ratio = if wave_count > 0.0 && single_request_ms > 0.0 {
            (total_duration.as_secs_f64() * 1000.0) / (wave_count * single_request_ms)
        } else {
            0.0
        };

        AggregatedResult {
            model: model.to_string(),
            concurrency,
            request_count: success_count,
            error_count,
            avg_ttft_ms: avg_ttft,
            min_ttft_ms: min_ttft,
            max_ttft_ms: max_ttft,
            p50_ttft_ms: p50_ttft,
            p95_ttft_ms: p95_ttft,
            p99_ttft_ms: p99_ttft,
            avg_output_speed_tps: avg_output_speed,
            avg_tps,
            total_tokens,
            input_tokens_avg,
            output_tokens_avg,
            token_source,
            single_request_ms,
            wave_count,
            saturation_ratio,
            success_rate,
            total_duration_secs: total_duration.as_secs_f64(),
            error_summary,
        }
    }

    async fn persist(&self, record: DailyTestRecord) -> Result<(), String> {
        let db = self.db.clone();
        match tokio::task::spawn_blocking(move || {
            let conn = db.lock().map_err(|_| "db mutex poisoned".to_string())?;
            db::insert_record(&conn, &record).map_err(|e| e.to_string())
        })
        .await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(e),
            Err(e) => Err(format!("join error: {e}")),
        }
    }

    /// One-off warm-up for a model, **before** any measured level runs.
    ///
    /// 设计要点（与旧的按档预热不同）：
    ///   - 单并发（concurrency = 1）：预热只负责把模型"跑热"——加载权重、
    ///     捕获 CUDA graph、编译 kernel。这些是一次性成本，属于部署环境，
    ///     不该记到任何并发档头上。
    ///   - 结果完全丢弃：既不计时、也不进统计、也不写库。
    ///   - 只跑一次：后续各并发档不再预热，因此各档墙钟与统计同口径，
    ///     饱和判定才有意义（旧实现让 2 个 warmup 混在 32 个测量请求里
    ///     同时起跑，既没预热成功，又把冷启动开销摊进了墙钟）。
    async fn warmup_model(&self, model: &str, questions: &[String]) -> Option<f64> {
        let count = self.config.warmup_count();
        if count == 0 {
            return None;
        }

        info!(
            model = %model,
            count = count,
            "Warming up model (concurrency 1, excluded from all statistics)"
        );
        let start = Instant::now();
        let no_cancel = Arc::new(AtomicBool::new(false));

        for index in 0..count {
            let raw_question = if questions.is_empty() {
                String::new()
            } else {
                questions[index % questions.len()].clone()
            };
            let spec = RequestSpec {
                url: format!("{}/v1/chat/completions", self.config.base_url),
                api_key: self.config.api_key.clone(),
                model: model.to_string(),
                question: prompt_for_request(&raw_question, &self.config),
                max_tokens: self.config.effective_output_tokens(),
                concurrency: 1,
                include_usage: false,
            };
            // 预热失败不致命：模型可能本就不可用，后续档位会如实记错误。
            let result =
                Self::run_single_api_request(self.client.clone(), spec, no_cancel.clone()).await;
            if !result.success {
                warn!(
                    model = %model,
                    error = %result.error.as_deref().unwrap_or("unknown"),
                    "Warm-up request failed (ignored)"
                );
            }
        }

        let secs = start.elapsed().as_secs_f64();
        info!(model = %model, warmup_secs = secs, "Model warm-up finished");
        Some(secs)
    }

    async fn run_single_model(
        &self,
        model: &str,
        level_questions: &[Vec<String>],
        today: &str,
        progress: &Arc<RunProgress>,
        usage: &UsagePlan,
    ) -> Vec<DailyTestRecord> {
        let mut records = Vec::new();

        // 模型级预热：单并发、跑一次、完全不计入统计与墙钟。
        let warmup_questions = level_questions.first().cloned().unwrap_or_default();
        self.warmup_model(model, &warmup_questions).await;

        for (level_idx, &concurrency) in self.config.concurrency_levels.iter().enumerate() {
            if progress.is_cancelled() {
                break;
            }
            info!(model = %model, concurrency = concurrency, runs = self.config.test_runs, "Starting test");
            let mut run_results = Vec::new();
            for run in 1..=self.config.test_runs {
                if progress.is_cancelled() {
                    break;
                }
                info!(model = %model, concurrency = concurrency, run = run, "Test run");
                run_results.push(
                    self.test_model_concurrency(
                        model,
                        concurrency,
                        &level_questions[level_idx],
                        progress,
                        usage,
                    )
                    .await,
                );
            }
            if run_results.is_empty() {
                break;
            }
            if progress.is_cancelled() {
                break;
            }

            let record = merge_runs(
                model,
                concurrency,
                today,
                self.config.timezone_offset_hours,
                &run_results,
                self.config.cache_bust,
            );
            if let Err(error) = self.persist(record.clone()).await {
                error!(error = %error, model = %model, "Failed to insert test record");
            }
            records.push(record);
        }

        info!(model = %model, count = records.len(), "Model test completed");
        records
    }

    pub async fn run_model_test(
        &self,
        model: &str,
        progress: Arc<RunProgress>,
    ) -> Result<Vec<DailyTestRecord>, String> {
        // Protocol v2: one question set per concurrency level (rotating the
        // set per level, shared by all models of the run, keeps model-vs-model
        // comparisons at the same level fair while breaking prefix-cache reuse
        // across levels).
        let level_questions: Vec<Vec<String>> = self
            .config
            .concurrency_levels
            .iter()
            .map(|_| questions::pick_random_questions(self.config.questions_per_run))
            .collect();
        let usage = self.prepare_usage(model).await;
        let today = today_local(self.config.timezone_offset_hours);
        progress.begin(&[(model.to_string(), self.config.requests_per_model())]);
        progress.set_model_status(model, MODEL_RUNNING);

        let records = self
            .run_single_model(model, &level_questions, &today, &progress, &usage)
            .await;

        progress.set_model_status(
            model,
            if progress.is_cancelled() {
                MODEL_PENDING
            } else if records.iter().all(|r| r.error_count > 0) && !records.is_empty() {
                MODEL_ERROR
            } else {
                MODEL_DONE
            },
        );
        Ok(records)
    }

    /// Run full test suite for all models at all concurrency levels.
    /// Each model runs in a separate tokio task — models are tested in parallel.
    pub async fn run_full_test(
        &self,
        progress: Arc<RunProgress>,
    ) -> Result<Vec<DailyTestRecord>, String> {
        info!("Starting full performance test suite");
        // Cap the model-list fetch so a hung upstream cannot hold the run open;
        // the per-request timeout (30 min by default) is far too long for this.
        let models = match tokio::time::timeout(MODEL_LIST_TIMEOUT, self.fetch_models()).await {
            Ok(result) => result?,
            Err(_) => return Err("Timed out fetching /v1/models".to_string()),
        };
        if progress.is_cancelled() {
            return Ok(Vec::new());
        }
        let model_ids: Vec<String> = models.into_iter().map(|model| model.id).collect();
        info!(model_count = model_ids.len(), models = ?model_ids, "Models fetched");

        if model_ids.is_empty() {
            return Err("No models returned from /v1/models".to_string());
        }

        // Protocol v2: one question set per concurrency level, sampled once and
        // shared by every model of the run — model-vs-model comparisons at the
        // same level stay on identical content while the per-level rotation
        // breaks prefix-cache reuse across levels.
        let level_questions = Arc::new(
            self.config
                .concurrency_levels
                .iter()
                .map(|_| questions::pick_random_questions(self.config.questions_per_run))
                .collect::<Vec<Vec<String>>>(),
        );
        // Negotiate the usage capability once for the whole run (one cheap
        // probe) before the model fan-out; every request in the run reuses the
        // resolved value.
        let usage = Arc::new(self.prepare_usage(&model_ids[0]).await);
        let today = today_local(self.config.timezone_offset_hours);
        let per_model_total = self.config.requests_per_model();

        progress.begin(
            &model_ids
                .iter()
                .map(|model| (model.clone(), per_model_total))
                .collect::<Vec<_>>(),
        );

        let model_slots = Arc::new(tokio::sync::Semaphore::new(self.config.max_parallel_models));
        let mut model_handles = Vec::new();
        for model in model_ids {
            let level_questions = level_questions.clone();
            let usage = usage.clone();
            let config = self.config.clone();
            let today = today.clone();
            let progress = progress.clone();
            let db = self.db.clone();
            let client = self.client.clone();
            let model_slots = model_slots.clone();
            model_handles.push(tokio::spawn(async move {
                // Never run more than MAX_PARALLEL_MODELS at once: each model
                // already fans out to `concurrency` in-flight requests.
                let _permit = model_slots.acquire().await.expect("semaphore closed");
                progress.set_model_status(&model, MODEL_RUNNING);
                let runner = TestRunner { client, config, db };
                let records = runner
                    .run_single_model(&model, &level_questions, &today, &progress, &usage)
                    .await;
                let status = if progress.is_cancelled() {
                    MODEL_PENDING
                } else if !records.is_empty() && records.iter().all(|r| r.error_count > 0) {
                    MODEL_ERROR
                } else {
                    MODEL_DONE
                };
                progress.set_model_status(&model, status);
                records
            }));
        }

        let mut all_records = Vec::new();
        for handle in model_handles {
            match handle.await {
                Ok(records) => all_records.extend(records),
                Err(error) => {
                    error!("Model task join error: {}", error);
                }
            }
        }

        info!(
            total_records = all_records.len(),
            "Full performance test completed"
        );
        Ok(all_records)
    }
}

/// Aggregate the `test_runs` rounds of one concurrency level into a DB record.
fn merge_runs(
    model: &str,
    concurrency: usize,
    today: &str,
    tz_offset_hours: i32,
    runs: &[AggregatedResult],
    cache_bust: bool,
) -> DailyTestRecord {
    let successes: usize = runs.iter().map(|run| run.request_count).sum();
    let failures: usize = runs.iter().map(|run| run.error_count).sum();
    let attempts = successes + failures;

    // Latency/throughput are weighted by successful requests so a run with a
    // single slow sample cannot dominate the merged record.
    let weight = |pick: fn(&AggregatedResult) -> f64| -> f64 {
        if successes == 0 {
            0.0
        } else {
            runs.iter()
                .map(|run| pick(run) * run.request_count as f64)
                .sum::<f64>()
                / successes as f64
        }
    };

    let min_ttft = runs
        .iter()
        .map(|run| run.min_ttft_ms)
        .fold(f64::MAX, f64::min);
    let max_ttft = runs
        .iter()
        .map(|run| run.max_ttft_ms)
        .fold(f64::MIN, f64::max);

    let mut error_summary: BTreeMap<String, usize> = BTreeMap::new();
    for run in runs {
        for (message, count) in &run.error_summary {
            *error_summary.entry(message.clone()).or_insert(0) += count;
        }
    }

    // success_rate is derived from the merged counts, so
    // request_count / (request_count + error_count) always matches it.
    let success_rate = if attempts == 0 {
        0.0
    } else {
        successes as f64 / attempts as f64 * 100.0
    };

    DailyTestRecord {
        id: 0,
        test_date: today.to_string(),
        model: model.to_string(),
        concurrency,
        request_count: successes,
        error_count: failures,
        error_summary: top_errors(error_summary),
        avg_ttft_ms: weight(|run| run.avg_ttft_ms),
        min_ttft_ms: if min_ttft == f64::MAX { 0.0 } else { min_ttft },
        max_ttft_ms: if max_ttft == f64::MIN { 0.0 } else { max_ttft },
        p50_ttft_ms: weight(|run| run.p50_ttft_ms),
        p95_ttft_ms: weight(|run| run.p95_ttft_ms),
        p99_ttft_ms: weight(|run| run.p99_ttft_ms),
        avg_output_speed_tps: weight(|run| run.avg_output_speed_tps),
        avg_tps: weight(|run| run.avg_tps),
        total_tokens: runs.iter().map(|run| run.total_tokens).sum(),
        input_tokens: weight(|run| run.input_tokens_avg),
        output_tokens: weight(|run| run.output_tokens_avg),
        single_request_ms: weight(|run| run.single_request_ms),
        wave_count: runs.iter().map(|run| run.wave_count).sum(),
        saturation_ratio: weight(|run| run.saturation_ratio),
        token_source: if runs.iter().any(|run| run.token_source == "usage") {
            "usage".to_string()
        } else {
            "estimate".to_string()
        },
        protocol_version: PROTOCOL_VERSION.to_string(),
        cache_bust,
        success_rate,
        total_duration_secs: runs.iter().map(|run| run.total_duration_secs).sum(),
        created_at: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        created_at_local: local_now(tz_offset_hours),
    }
}

/// Mean of a slice, 0.0 when empty.
fn mean(values: Vec<f64>) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

/// Keep only the 5 most frequent error summaries, longest tail folded in.
fn top_errors(mut errors: BTreeMap<String, usize>) -> BTreeMap<String, usize> {
    const MAX: usize = 5;
    if errors.len() <= MAX {
        return errors;
    }
    let mut pairs: Vec<(String, usize)> = errors.into_iter().collect();
    pairs.sort_by_key(|pair| std::cmp::Reverse(pair.1));
    pairs.truncate(MAX);
    errors = pairs.into_iter().collect();
    errors
}

/// Collapse an error string into a stable, human-readable bucket key.
fn summarize_error(raw: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    const LIMIT: usize = 140;
    if collapsed.chars().count() <= LIMIT {
        collapsed
    } else {
        let truncated: String = collapsed.chars().take(LIMIT).collect();
        format!("{truncated}…")
    }
}

/// Whether a failed request is worth retrying.
fn should_retry_error(error: &str) -> bool {
    const STATUS_PREFIXES: &[&str] = &[
        "HTTP 429", "HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504", "HTTP 520", "HTTP 522",
        "HTTP 524", "HTTP 525", "HTTP 527", "HTTP 554",
    ];
    const NEEDLES: &[&str] = &[
        "error decoding response body",
        "connection closed",
        "Connection reset",
        "connection reset",
        "broken pipe",
        "timed out",
        "Timeout",
        "Stream error",
    ];
    let error = error.trim();
    STATUS_PREFIXES
        .iter()
        .any(|prefix| error.starts_with(prefix))
        || NEEDLES.iter().any(|needle| error.contains(needle))
}

/// Byte-oriented SSE line accumulator.
///
/// Network chunks split SSE frames at arbitrary byte offsets — including in the
/// middle of a multi-byte UTF-8 character — so buffering must happen on bytes
/// and only decode a line once its terminating `\n` has arrived.
#[derive(Default)]
struct SseLineBuffer {
    buffer: Vec<u8>,
}

impl SseLineBuffer {
    /// Append a chunk and return every complete line it completed.
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut consumed = 0usize;
        while let Some(relative) = self.buffer[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let end = consumed + relative;
            lines.push(String::from_utf8_lossy(&self.buffer[consumed..end]).into_owned());
            consumed = end + 1;
        }
        if consumed > 0 {
            self.buffer.drain(..consumed);
        }
        lines
    }

    /// Remaining bytes when the stream ended without a trailing newline.
    fn take_rest(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            return None;
        }
        let rest = String::from_utf8_lossy(&self.buffer).into_owned();
        self.buffer.clear();
        Some(rest)
    }
}

/// Rolling stats accumulated from one SSE stream.
#[derive(Default)]
struct StreamStats {
    first_token: Option<Duration>,
    content: String,
    usage: Option<UsageInfo>,
    /// Error reported inside a 200 stream (`data: {"error": {...}}`).
    error: Option<String>,
}

/// Handle one SSE line (`data: {...}`) of a streaming chat completion.
fn process_sse_line(line: &str, stats: &mut StreamStats, start: Instant) {
    let line = line.trim();
    if line.is_empty() || line.starts_with(':') {
        return;
    }
    let data = match line.strip_prefix("data:") {
        Some(rest) => rest.trim_start(),
        None => line,
    };
    if data == "[DONE]" {
        return;
    }
    let chunk: ChatChunk = match serde_json::from_str(data) {
        Ok(chunk) => chunk,
        Err(_) => {
            debug!(line = %data, "Unparsable SSE line");
            return;
        }
    };

    if let Some(error) = chunk.error {
        let message = error
            .get("message")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| error.to_string());
        stats.error = Some(message);
    }

    if let Some(usage) = chunk.usage {
        if usage.completion_tokens.is_some() {
            stats.usage = Some(usage);
        }
    }

    for choice in chunk.choices {
        let content = choice.delta.content.unwrap_or_default();
        let reasoning = choice
            .delta
            .reasoning
            .or(choice.delta.reasoning_content)
            .unwrap_or_default();
        if stats.first_token.is_none() && (!content.is_empty() || !reasoning.is_empty()) {
            stats.first_token = Some(start.elapsed());
        }
        stats.content.push_str(&reasoning);
        stats.content.push_str(&content);
    }
}

/// Estimated completion tokens when the server does not return `usage`.
/// CJK characters count as one token each, everything else as ~4 chars/token.
/// Extract the HTTP status code from a `RequestResult` error string of the
/// form `"HTTP 400: <body>"` (the gateway-rejection case of the usage probe).
fn http_status_from_error(error: Option<&str>) -> Option<u16> {
    error?
        .strip_prefix("HTTP ")?
        .split_whitespace()
        .next()?
        .trim_end_matches(':')
        .parse()
        .ok()
}

fn estimate_tokens(text: &str) -> i64 {
    if text.trim().is_empty() {
        return 0;
    }
    let mut cjk = 0usize;
    let mut other = 0usize;
    for ch in text.chars() {
        if is_cjk(ch) {
            cjk += 1;
        } else if !ch.is_whitespace() {
            other += 1;
        }
    }
    (cjk + other.div_ceil(4)).max(1) as i64
}

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0x3040..=0x30FF
        | 0xAC00..=0xD7AF
        | 0xF900..=0xFAFF
        | 0x20000..=0x2FA1F)
}

/// Calculate percentile from sorted slice
fn percentile(sorted_data: &[f64], p: f64) -> f64 {
    if sorted_data.is_empty() {
        return 0.0;
    }
    if sorted_data.len() == 1 {
        return sorted_data[0];
    }

    let k = (p / 100.0) * (sorted_data.len() - 1) as f64;
    let f = k.floor() as usize;
    let c = k.ceil() as usize;

    if f == c {
        sorted_data[f]
    } else {
        let d0 = sorted_data[f] * (c as f64 - k);
        let d1 = sorted_data[c] * (k - f as f64);
        d0 + d1
    }
}

/// Extension trait for optional auth header
trait RequestBuilderExt {
    fn optional_auth(self, api_key: &Option<String>) -> Self;
}

impl RequestBuilderExt for reqwest::RequestBuilder {
    fn optional_auth(self, api_key: &Option<String>) -> Self {
        match api_key {
            Some(key) => self.bearer_auth(key),
            None => self,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_prompt, estimate_tokens, http_status_from_error, merge_runs, percentile,
        process_sse_line, prompt_for_request, should_retry_error, SseLineBuffer, StreamStats,
    };
    use crate::config::{band_requests, Config};
    use crate::config::{UsageMode, PROTOCOL_VERSION};
    use crate::models::AggregatedResult;
    use std::collections::BTreeMap;
    use std::time::Instant;

    #[test]
    fn request_count_keeps_bands_and_respects_floor() {
        // Band formula alone
        assert_eq!(band_requests(1), 3);
        assert_eq!(band_requests(4), 12);
        assert_eq!(band_requests(8), 16);
        assert_eq!(band_requests(32), 32);
        // With the default floor of 10 requests, low levels stop using 3 samples.
        let config = test_config(10);
        assert_eq!(config.requests_for_level(1), 10);
        assert_eq!(config.requests_for_level(2), 10);
        assert_eq!(config.requests_for_level(4), 12);
        assert_eq!(config.requests_for_level(64), 64);
        // Floor disabled keeps the historical numbers.
        let config = test_config(0);
        assert_eq!(config.requests_for_level(1), 3);
        assert_eq!(config.requests_for_level(64), 64);
        // A whole-model plan multiplies by TEST_RUNS.
        let config = test_config(10);
        assert_eq!(
            config.requests_per_model(),
            (10 + 10 + 12 + 16 + 32 + 32 + 64) * 2
        );
    }

    #[test]
    fn percentile_handles_small_and_multi_sample_inputs() {
        assert_eq!(percentile(&[], 95.0), 0.0);
        assert_eq!(percentile(&[42.0], 95.0), 42.0);
        let data = [1.0, 2.0, 3.0, 4.0, 5.0];
        assert_eq!(percentile(&data, 50.0), 3.0);
        assert!(percentile(&data, 100.0) >= 5.0 - f64::EPSILON);
    }

    #[test]
    fn sse_buffer_reassembles_lines_split_across_chunks() {
        let mut buffer = SseLineBuffer::default();
        let first = buffer.push(b"data: {\"a\":1}\n\ndata: {\"b\"");
        assert_eq!(first, vec!["data: {\"a\":1}".to_string(), String::new()]);
        let second = buffer.push(b":2}\n\n");
        assert_eq!(second, vec!["data: {\"b\":2}".to_string(), String::new()]);
        assert_eq!(buffer.take_rest(), None);
    }

    #[test]
    fn sse_buffer_keeps_multibyte_characters_intact() {
        let payload = "data: {\"choices\":[{\"delta\":{\"content\":\"你好，世界\"}}]}\n\n";
        let bytes = payload.as_bytes();
        // Split inside the third Chinese character: 3 bytes each, so offset 3+3+3+1.
        let split_at = 10 + 3 + 3 + 1;
        let mut buffer = SseLineBuffer::default();
        let first = buffer.push(&bytes[..split_at]);
        let second = buffer.push(&bytes[split_at..]);
        assert!(first.is_empty(), "the first chunk ends mid-character");
        assert_eq!(second.len(), 2, "two empty lines terminate the SSE frame");
        assert!(
            second[0].contains("你好，世界"),
            "no replacement characters"
        );
        assert!(!second[0].contains('\u{fffd}'));
    }

    #[test]
    fn sse_buffer_flushes_a_final_line_without_newline() {
        let mut buffer = SseLineBuffer::default();
        assert!(buffer.push(b"data: {\"x\":1}").is_empty());
        assert_eq!(buffer.take_rest().as_deref(), Some("data: {\"x\":1}"));
        assert_eq!(buffer.take_rest(), None);
    }

    fn run(
        successes: usize,
        failures: usize,
        avg_ttft: f64,
        tokens: i64,
        duration: f64,
    ) -> AggregatedResult {
        run_detailed(successes, failures, avg_ttft, tokens, duration, 800.0, 2.0)
    }

    fn run_detailed(
        successes: usize,
        failures: usize,
        avg_ttft: f64,
        tokens: i64,
        duration: f64,
        single_request_ms: f64,
        wave_count: f64,
    ) -> AggregatedResult {
        let mut error_summary = BTreeMap::new();
        if failures > 0 {
            error_summary.insert("HTTP 429: slow down".to_string(), failures);
        }
        AggregatedResult {
            model: "m".to_string(),
            concurrency: 8,
            request_count: successes,
            error_count: failures,
            avg_ttft_ms: avg_ttft,
            min_ttft_ms: avg_ttft * 0.9,
            max_ttft_ms: avg_ttft * 1.2,
            p50_ttft_ms: avg_ttft,
            p95_ttft_ms: avg_ttft * 1.1,
            p99_ttft_ms: avg_ttft * 1.15,
            avg_output_speed_tps: 20.0,
            avg_tps: 18.0,
            total_tokens: tokens,
            input_tokens_avg: 32.0,
            output_tokens_avg: if successes + failures == 0 {
                0.0
            } else {
                tokens as f64 / (successes + failures) as f64
            },
            token_source: "estimate".to_string(),
            single_request_ms,
            wave_count,
            saturation_ratio: if wave_count > 0.0 && single_request_ms > 0.0 {
                duration * 1000.0 / (wave_count * single_request_ms)
            } else {
                0.0
            },
            success_rate: if successes + failures == 0 {
                0.0
            } else {
                successes as f64 / (successes + failures) as f64 * 100.0
            },
            total_duration_secs: duration,
            error_summary,
        }
    }

    #[test]
    fn merged_runs_use_totals_and_keep_success_rate_consistent() {
        let runs = vec![run(10, 2, 100.0, 1000, 10.0), run(20, 0, 200.0, 2000, 20.0)];
        let record = merge_runs("m", 8, "2026-08-27", 8, &runs, false);

        assert_eq!(
            record.request_count, 30,
            "successes are summed, not averaged"
        );
        assert_eq!(record.error_count, 2);
        assert!((record.success_rate - 30.0 / 32.0 * 100.0).abs() < 1e-9);
        assert!(
            (record.success_rate
                - record.request_count as f64 / (record.request_count + record.error_count) as f64
                    * 100.0)
                .abs()
                < 1e-9,
            "success_rate must match request/error counts"
        );
        assert_eq!(record.total_tokens, 3000);
        assert!((record.total_duration_secs - 30.0).abs() < 1e-9);
        // latency weighted by successful requests
        assert!((record.avg_ttft_ms - (100.0 * 10.0 + 200.0 * 20.0) / 30.0).abs() < 1e-9);
        assert_eq!(record.error_summary["HTTP 429: slow down"], 2);
        assert_eq!(record.created_at_local.len(), 19);
    }

    #[test]
    fn stream_error_frames_are_captured_from_200_responses() {
        let mut stats = StreamStats::default();
        process_sse_line(
            r#"data: {"error":{"message":"upstream quota exceeded"}}"#,
            &mut stats,
            Instant::now(),
        );
        assert_eq!(stats.error.as_deref(), Some("upstream quota exceeded"));
        assert!(stats.content.is_empty());
        assert!(stats.usage.is_none());
    }

    #[test]
    fn first_token_timestamp_also_counts_reasoning_content() {
        let mut stats = StreamStats::default();
        let started = Instant::now();
        process_sse_line(
            r#"data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}"#,
            &mut stats,
            started,
        );
        assert!(stats.first_token.is_some());
        assert_eq!(stats.content, "thinking");
    }

    #[test]
    fn retry_classification_covers_gateway_and_stream_failures() {
        assert!(should_retry_error("HTTP 502: bad gateway"));
        assert!(should_retry_error("HTTP 429: slow down"));
        assert!(should_retry_error(
            "Stream error: connection closed before message completed"
        ));
        assert!(!should_retry_error("HTTP 401: bad key"));
        assert!(!should_retry_error("HTTP 400: bad model"));
    }

    #[test]
    fn token_estimate_prefers_cjk_characters() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("你好世界"), 4);
        assert_eq!(estimate_tokens("hello world"), 3);
    }

    #[test]
    fn prompt_budget_zero_keeps_question_verbatim() {
        let q = "Describe the history of computing in detail.";
        assert_eq!(build_prompt(q, 0), q);
    }

    #[test]
    fn prompt_budget_pads_short_questions_with_filler() {
        let q = "What is 1+1?";
        let body = build_prompt(q, 100); // target: 400 chars
        assert!(body.starts_with(q), "the question stays first");
        assert!(
            body.chars().count() >= 399,
            "padded toward the 400-char budget"
        );
        assert!(
            body.contains("quick brown fox"),
            "filler extends the prompt"
        );
    }

    #[test]
    fn prompt_budget_truncates_long_questions() {
        let q = "x".repeat(1000);
        let body = build_prompt(&q, 10); // target: 40 chars
        assert_eq!(body.chars().count(), 40);
        assert!(body.starts_with("xxxxxxxx"));
    }

    #[test]
    fn cache_bust_puts_unique_nonce_at_prompt_head() {
        let mut bust = test_config(2);
        bust.cache_bust = true;
        bust.input_tokens = 0;
        let a = prompt_for_request("Question A?", &bust);
        let b = prompt_for_request("Question A?", &bust);
        assert!(a.starts_with("# qh-"), "nonce must lead the prompt: {a}");
        assert!(b.starts_with("# qh-"));
        assert_ne!(a, b, "per-request nonces must differ");
        assert!(a.contains("Question A?"), "question survives the busting");

        let mut plain = test_config(2);
        plain.cache_bust = false;
        assert_eq!(
            prompt_for_request("Question A?", &plain),
            "Question A?",
            "no marker when busting is off (v1 caliber)"
        );
    }

    #[test]
    fn http_status_parsing_covers_probe_outcomes() {
        assert_eq!(
            http_status_from_error(Some("HTTP 400: unknown field")),
            Some(400)
        );
        assert_eq!(
            http_status_from_error(Some("HTTP 422: rejected")),
            Some(422)
        );
        assert_eq!(
            http_status_from_error(Some("HTTP 503: unavailable")),
            Some(503)
        );
        assert_eq!(
            http_status_from_error(Some("Request failed: timeout")),
            None
        );
        assert_eq!(http_status_from_error(None), None);
    }

    #[test]
    fn saturated_record_keeps_wave_and_single_request_basis() {
        // 每轮 10 个成功请求、单请求实测 1.2s、整档 3.4s。
        // concurrency=8 时两轮共 20 请求 = 2.5 波，理论并行时长 3.0s，
        // 实测 6.8s（两轮累加）→ 饱和比约 2.27，说明请求在排队。
        // 每轮 10 个成功请求、单请求实测 1.2s、每轮墙钟 3.4s。
        // 两轮合计 20 请求 / 8 并发 = 2.5 波；理想并行 = 2.5 × 1.2 = 3.0s，
        // 实测两轮累加 6.8s → 饱和比 ≈ 2.27，说明请求在排队。
        let runs = vec![
            run_detailed(10, 0, 100.0, 1200, 3.4, 1200.0, 1.25),
            run_detailed(10, 0, 100.0, 1200, 3.4, 1200.0, 1.25),
        ];
        let record = merge_runs("m", 8, "2026-08-27", 8, &runs, true);
        assert!(
            (record.single_request_ms - 1200.0).abs() < 1e-6,
            "单请求时长按成功请求加权，实测值 {}",
            record.single_request_ms
        );
        assert!(
            (record.wave_count - 2.5).abs() < 1e-6,
            "两轮各 1.25 波，合计 2.5 波，实际 {}",
            record.wave_count
        );
        assert!(
            record.saturation_ratio > 1.0,
            "墙钟 6.8s 超过理想并行 3.0s，饱和比应 > 1，实际 {}",
            record.saturation_ratio
        );
    }

    #[test]
    fn unsaturated_record_has_ratio_near_one() {
        // 单请求 1.0s，8 并发 1.25 波 → 理想 1.25s，实测给 1.25s → 比率≈1。
        // 单请求 1.0s，8 并发 1.25 波 → 理想并行 1.25s，实测 1.25s。
        let runs = vec![run_detailed(10, 0, 100.0, 1000, 1.25, 1000.0, 1.25)];
        let record = merge_runs("m", 8, "2026-08-27", 8, &runs, true);
        assert!(
            (record.saturation_ratio - 1.0).abs() < 0.05,
            "理想并行下饱和比应≈1，实际 {}",
            record.saturation_ratio
        );
    }

    #[test]
    fn merged_record_carries_protocol_metadata() {
        let runs = vec![run(10, 0, 100.0, 1000, 10.0)];
        let record = merge_runs("m", 8, "2026-08-27", 8, &runs, true);
        assert_eq!(record.protocol_version, PROTOCOL_VERSION);
        assert!(record.cache_bust);
        assert_eq!(record.token_source, "estimate");
        assert_eq!(record.input_tokens, 32.0);
        assert_eq!(record.output_tokens, 100.0);
    }

    fn test_config(requests_per_level: usize) -> Config {
        Config {
            base_url: "http://localhost".into(),
            api_key: None,
            host: "127.0.0.1".into(),
            port: 0,
            db_path: "data/test.db".into(),
            assets_dir: None,
            concurrency_levels: vec![1, 2, 4, 8, 16, 32, 64],
            requests_per_level,
            test_runs: 2,
            min_waves: 0,
            questions_per_run: 1,
            max_tokens: 16,
            stream_include_usage: UsageMode::Off,
            cache_bust: false,
            warmup_requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            request_timeout_secs: 5,
            timezone_offset_hours: 8,
            scheduled_hour: 3,
            scheduled_minute: 0,
            max_parallel_models: 8,
            models_cache_secs: 60,
            cors_origins: vec![],
            run_on_start: false,
        }
    }
}
