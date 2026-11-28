use std::env;
use std::path::PathBuf;

/// Measurement protocol version implemented by this binary.
///
/// Records carry the version they were produced under, so a trend chart never
/// mixes incompatible calibers silently (v1 = pre-negotiation, no cache bust,
/// no token budgets; v2 = protocol v2, see docs/OPEN_SOURCE_PLAN.md §0.3).
pub const PROTOCOL_VERSION: &str = "2";

/// How the tester should obtain exact token usage from the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageMode {
    /// Negotiate: probe once per run and persist the endpoint capability.
    /// (default) Sends `stream_options.include_usage` only while/after the
    /// server proves it answers it.
    Auto,
    /// Always send the field. Trust the server; a rejecting gateway fails the
    /// run loudly instead of degrading silently.
    On,
    /// Never send the field. TPS is estimated from output characters.
    Off,
}

impl std::fmt::Display for UsageMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            UsageMode::Auto => "auto",
            UsageMode::On => "on",
            UsageMode::Off => "off",
        })
    }
}

/// Parse `STREAM_INCLUDE_USAGE`. `auto` (default) negotiates; legacy
/// `true/false` values still map to `On`/`Off`.
pub fn parse_usage_mode(raw: &str) -> UsageMode {
    match raw.trim().to_ascii_lowercase().as_str() {
        "auto" => UsageMode::Auto,
        "1" | "true" | "yes" | "on" => UsageMode::On,
        "0" | "false" | "no" | "off" => UsageMode::Off,
        other => panic!("STREAM_INCLUDE_USAGE must be auto, true or false (got {other:?})"),
    }
}

/// Application configuration loaded from environment variables.
///
/// Every field is resolved once at startup (fail-fast) and then shared
/// immutably through `Arc<Config>`.
#[derive(Debug, Clone)]
pub struct Config {
    /// Base URL of the LLM API (e.g. http://localhost:8000)
    pub base_url: String,
    /// API key (optional, for Bearer auth)
    pub api_key: Option<String>,
    /// Host to bind the web server
    pub host: String,
    /// Port to bind the web server
    pub port: u16,
    /// Database file path
    pub db_path: PathBuf,
    /// Optional directory override for static assets (CSS/JS/vendor).
    /// When unset the server probes `./assets`, `/app/assets` and the
    /// build-time source tree in that order.
    pub assets_dir: Option<PathBuf>,
    /// Concurrency levels to test
    pub concurrency_levels: Vec<usize>,
    /// Minimum requests per concurrency level (0 = use the built-in band only)
    pub requests_per_level: usize,
    /// Number of test runs per concurrency level (for averaging).
    ///
    /// Default 2: a single round gives one sample per level, which cannot
    /// distinguish "truly parallel" from "just did not queue yet".
    pub test_runs: usize,
    /// Number of random questions per test run
    pub questions_per_run: usize,
    /// Max tokens for model responses (legacy output budget; `OUTPUT_TOKENS`
    /// overrides it when set)
    pub max_tokens: u32,
    /// How to obtain exact token usage (auto/on/off). Auto probes the endpoint
    /// once per run and persists the capability in `endpoint_capabilities`.
    pub stream_include_usage: UsageMode,
    /// Protocol v2: defeat prefix caching by prepending a per-request nonce to
    /// the prompt head (prefix caches match from the start, so a different
    /// head invalidates reuse of the whole prompt) and rotating the question
    /// set per concurrency level. Off = historical v1 caliber.
    pub cache_bust: bool,
    /// Warm-up requests issued once per model, at concurrency 1, *before* any
    /// measured level runs.
    ///
    /// Rationale: a cold model pays one-off costs (CUDA graph capture, kernel
    /// build, KV-cache allocation). Those costs belong to the deployment, not
    /// to any particular concurrency level, so they are paid once up front and
    /// excluded from both timing and statistics. Per-level warm-up is gone:
    /// warming 2 requests cannot prepare a 128-wide batch anyway, and it only
    /// inflated the level wall clock.
    pub warmup_requests: usize,
    /// Protocol v2: target input length in tokens (0 = use the question bank
    /// as-is). The prompt is padded/truncated to `input_tokens * 4` chars
    /// (tokenizer-free estimate; exact sizing needs the tokenizer, P1 follow-up).
    pub input_tokens: u32,
    /// Protocol v2: output token budget (`max_tokens`). 0 = fall back to `MAX_TOKENS`.
    pub output_tokens: u32,
    /// Request timeout in seconds
    pub request_timeout_secs: u64,
    /// Timezone offset from UTC (UTC+8 = 8)
    pub timezone_offset_hours: i32,
    /// Scheduled test hour in local time
    pub scheduled_hour: u32,
    /// Scheduled test minute in local time
    pub scheduled_minute: u32,
    /// How many models are tested at the same time. Each model already runs
    /// `concurrency` in-flight requests, so this caps the total fan-out.
    pub max_parallel_models: usize,
    /// How long the `/v1/models` list is cached, in seconds
    pub models_cache_secs: u64,
    /// Allowed CORS origins. Empty means "same origin only" (no CORS layer).
    pub cors_origins: Vec<String>,
    /// Run a test automatically on startup when today has no data yet
    pub run_on_start: bool,
}

fn env_parse<T>(key: &str, default: T) -> T
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match env::var(key) {
        Ok(raw) => raw
            .trim()
            .parse::<T>()
            .unwrap_or_else(|e| panic!("{key} must be valid: {e}")),
        Err(_) => default,
    }
}

fn env_bool(key: &str, default: bool) -> bool {
    match env::var(key) {
        Ok(raw) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

impl Config {
    pub fn from_env() -> Self {
        let base_url = env::var("BASE_URL").unwrap_or_else(|_| "http://localhost:8000".to_string());
        let host = env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
        let port = env_parse::<u16>("PORT", 3000);

        let db_path = env::var("DB_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("data/records.db"));

        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).ok();
            }
        }

        let assets_dir = env::var("ASSETS_DIR").ok().map(PathBuf::from);

        let concurrency_str =
            env::var("CONCURRENCY_LEVELS").unwrap_or_else(|_| "1,2,4,8,16,32,64".to_string());
        let mut concurrency_levels: Vec<usize> = concurrency_str
            .split(',')
            .filter_map(|s| s.trim().parse::<usize>().ok())
            .filter(|level| *level > 0)
            .collect();
        concurrency_levels.sort_unstable();
        concurrency_levels.dedup();
        if concurrency_levels.is_empty() {
            panic!("CONCURRENCY_LEVELS must contain at least one positive integer");
        }

        let requests_per_level = env_parse::<usize>("REQUESTS_PER_LEVEL", 10);
        let test_runs = env_parse::<usize>("TEST_RUNS", 2);
        if test_runs == 0 {
            panic!("TEST_RUNS must be >= 1");
        }

        let questions_per_run = env_parse::<usize>("QUESTIONS_PER_RUN", 10);
        if questions_per_run == 0 {
            panic!("QUESTIONS_PER_RUN must be >= 1");
        }

        let max_tokens = env_parse::<u32>("MAX_TOKENS", 512);
        let stream_include_usage = match env::var("STREAM_INCLUDE_USAGE") {
            Ok(raw) => parse_usage_mode(&raw),
            Err(_) => UsageMode::Auto,
        };
        let cache_bust = env_bool("CACHE_BUST", true);
        let warmup_requests = env_parse::<usize>("WARMUP_REQUESTS", 2);
        let input_tokens = env_parse::<u32>("INPUT_TOKENS", 0);
        let output_tokens = env_parse::<u32>("OUTPUT_TOKENS", 0);
        let request_timeout_secs = env_parse::<u64>("REQUEST_TIMEOUT_SECS", 1800);
        let timezone_offset_hours = env_parse::<i32>("TZ_OFFSET_HOURS", 8);
        let scheduled_hour = env_parse::<u32>("SCHEDULED_HOUR", 3);
        let scheduled_minute = env_parse::<u32>("SCHEDULED_MINUTE", 0);
        if scheduled_hour > 23 || scheduled_minute > 59 {
            panic!("SCHEDULED_HOUR must be 0..=23 and SCHEDULED_MINUTE 0..=59");
        }

        let max_parallel_models = env_parse::<usize>("MAX_PARALLEL_MODELS", 8).clamp(1, 32);
        let models_cache_secs = env_parse::<u64>("MODELS_CACHE_SECS", 60);
        let cors_origins = env::var("CORS_ORIGINS")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let run_on_start = env_bool("RUN_ON_START", true);

        Config {
            base_url,
            api_key: env::var("API_KEY").ok().filter(|k| !k.trim().is_empty()),
            host,
            port,
            db_path,
            assets_dir,
            concurrency_levels,
            requests_per_level,
            test_runs,
            questions_per_run,
            max_tokens,
            stream_include_usage,
            cache_bust,
            warmup_requests,
            input_tokens,
            output_tokens,
            request_timeout_secs,
            timezone_offset_hours,
            scheduled_hour,
            scheduled_minute,
            max_parallel_models,
            models_cache_secs,
            cors_origins,
            run_on_start,
        }
    }

    /// Calculate local time cron expression for the scheduled test
    pub fn cron_expression(&self) -> String {
        // Cron runs in UTC. Convert local scheduled time to UTC.
        // Local = UTC + offset, so UTC = Local - offset
        let local_minute = self.scheduled_minute as i32;
        let local_hour = self.scheduled_hour as i32;
        let offset = self.timezone_offset_hours;

        let mut utc_hour = local_hour - offset;
        let mut utc_minute = local_minute;

        // Handle minute/hour wrap-around
        while utc_minute < 0 {
            utc_minute += 60;
            utc_hour -= 1;
        }
        while utc_minute >= 60 {
            utc_minute -= 60;
            utc_hour += 1;
        }
        utc_hour = utc_hour.rem_euclid(24);

        // 7-field cron: sec min hour day mon dow year
        format!("0 {} {} * * * *", utc_minute, utc_hour)
    }

    /// Requests issued for one concurrency level in one test run.
    ///
    /// The historical band formula (3x for low concurrency, 2x for mid,
    /// 1x for high) is kept, but `REQUESTS_PER_LEVEL` now acts as a real
    /// lower bound so `p99` is not computed from three samples.
    pub fn requests_for_level(&self, concurrency: usize) -> usize {
        band_requests(concurrency).max(self.requests_per_level.max(1))
    }

    /// Warm-up requests for the one-off model-level stage (concurrency 1).
    /// Not multiplied by anything: it runs once, outside the measurement.
    pub fn warmup_count(&self) -> usize {
        self.warmup_requests
    }

    /// Output token budget sent as `max_tokens`.
    pub fn effective_output_tokens(&self) -> u32 {
        if self.output_tokens > 0 {
            self.output_tokens
        } else {
            self.max_tokens
        }
    }

    /// Total requests issued for one model across all concurrency levels
    /// (measured batches plus warm-up requests, which count toward progress).
    pub fn requests_per_model(&self) -> usize {
        // 每模型的请求数 = 各档测量请求 + 一次性的预热请求（单并发）
        self.concurrency_levels
            .iter()
            .map(|&level| self.requests_for_level(level) * self.test_runs)
            .sum::<usize>()
            + self.warmup_count()
    }
}

/// Built-in band: 3x at low concurrency, 2x at mid, 1x at high.
pub fn band_requests(concurrency: usize) -> usize {
    if concurrency <= 4 {
        concurrency * 3
    } else if concurrency <= 16 {
        concurrency * 2
    } else {
        concurrency
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config(cache_bust: bool, warmup: usize, output_tokens: u32) -> Config {
        Config {
            base_url: "http://localhost:8000".into(),
            api_key: None,
            host: "127.0.0.1".into(),
            port: 3000,
            db_path: "data/test.db".into(),
            assets_dir: None,
            concurrency_levels: vec![1, 2],
            requests_per_level: 4,
            test_runs: 1,
            questions_per_run: 2,
            max_tokens: 512,
            stream_include_usage: UsageMode::Auto,
            cache_bust,
            warmup_requests: warmup,
            input_tokens: 0,
            output_tokens,
            request_timeout_secs: 60,
            timezone_offset_hours: 8,
            scheduled_hour: 3,
            scheduled_minute: 0,
            max_parallel_models: 8,
            models_cache_secs: 60,
            cors_origins: vec![],
            run_on_start: false,
        }
    }

    #[test]
    fn usage_mode_parses_auto_and_legacy_values() {
        assert_eq!(parse_usage_mode("auto"), UsageMode::Auto);
        assert_eq!(parse_usage_mode("AUTO"), UsageMode::Auto);
        assert_eq!(parse_usage_mode("true"), UsageMode::On);
        assert_eq!(parse_usage_mode("on"), UsageMode::On);
        assert_eq!(parse_usage_mode("false"), UsageMode::Off);
        assert_eq!(parse_usage_mode("0"), UsageMode::Off);
        assert_eq!(parse_usage_mode("off"), UsageMode::Off);
    }

    #[test]
    fn usage_mode_display_round_trips() {
        for mode in [UsageMode::Auto, UsageMode::On, UsageMode::Off] {
            assert_eq!(parse_usage_mode(&mode.to_string()), mode);
        }
    }

    #[test]
    fn warmup_is_one_off_and_cache_bust_independent() {
        // 预热是模型级的一次性阶段（单并发），与 cache_bust 无关：
        // 它负责把模型跑热，而不是改善某一档的缓存状态。
        assert_eq!(sample_config(true, 3, 0).warmup_count(), 3);
        assert_eq!(sample_config(false, 3, 0).warmup_count(), 3);
        assert_eq!(sample_config(true, 0, 0).warmup_count(), 0, "0 = 关闭预热");
    }

    #[test]
    fn output_budget_precedes_max_tokens() {
        assert_eq!(sample_config(true, 0, 1024).effective_output_tokens(), 1024);
        assert_eq!(
            sample_config(true, 0, 0).effective_output_tokens(),
            512,
            "falls back to MAX_TOKENS when OUTPUT_TOKENS is unset"
        );
    }

    #[test]
    fn requests_per_model_adds_warmup_once_not_per_level() {
        // levels [1,2]，requests_per_level=4 → band(1)=3 被抬到 4，band(2)=6。
        // 预热只在模型级跑一次（2 个请求），不再按档累加。
        assert_eq!(sample_config(true, 2, 0).requests_per_model(), 4 + 6 + 2);
        assert_eq!(sample_config(false, 2, 0).requests_per_model(), 4 + 6 + 2);
    }
}
