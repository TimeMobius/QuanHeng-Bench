---
name: quanheng-bench
description: Query LLM API benchmark results (TTFT, throughput, success rate, error attribution) from a running QuanHeng-Bench instance, and trigger or cancel benchmark runs. Use when the user asks how fast a model/endpoint is, wants a performance comparison or trend, needs a regression check before/after a deployment, or asks to run a benchmark against an OpenAI-compatible API.
---

# QuanHeng-Bench

QuanHeng-Bench (权衡·基准) is a self-hosted LLM inference benchmark service: it drives real
streaming traffic against an OpenAI-compatible endpoint at a ladder of concurrency levels and
exposes the measurements over HTTP. It ships both a web UI for humans and this JSON API for
agents — no login, no token, a plain `curl` is enough.

## When to use this skill

- "How fast is model X / our gateway?" → read the latest snapshot.
- "Did yesterday's deploy regress TTFT?" → compare two dates or read the trend series.
- "Which model is fastest at 8 concurrent requests?" → sort the per-model records.
- "Run a benchmark now." → trigger a run, then poll status.
- "Why did success rate drop?" → read `error_count` / `error_summary`.

Do **not** invent numbers: if the API returns an empty record set, say there is no data yet
and offer to run a benchmark.

## Base URL

The instance address is whatever the user deployed, e.g. `http://localhost:3000`.
All timestamps and `test_date` follow the instance's `TZ_OFFSET_HOURS` (default UTC+8).

## Reading results

### One call gets everything for a day

```bash
curl -s "$BASE/api/dashboard?date=2026-11-24" | jq
```

Omit `date` for today. Response shape:

```
{ date, today, dates[], models[], summary, best, status, config, run_log[] }
```

- `models[]`: `{ id, icon, tested, status, has_data, records[], summary }`
  - `records[]`: one row per concurrency level —
    `{ concurrency, request_count, error_count, error_summary,
       avg_ttft_ms, min_ttft_ms, max_ttft_ms, p50_ttft_ms, p95_ttft_ms, p99_ttft_ms,
       avg_output_speed_tps, avg_tps, total_tokens,
       input_tokens, output_tokens, token_source, protocol_version, cache_bust,
       success_rate, total_duration_secs, created_at_local }`
  - `summary`: weighted aggregates for that model (weighted by request count, not by row).
- `summary` (top level): weighted across all models of that day.
- `best`: `{ ttft, p95, output_speed, tps, success_rate }`, each `{ model, value }`.

### Interpret the caliber before quoting numbers

Every record carries its measurement provenance — **quote it, do not ignore it**:

| Field | Meaning | What to tell the user |
|---|---|---|
| `protocol_version` | `"2"` current, `"1"` legacy | v1 rows predate cache busting; don't compare v1 and v2 directly |
| `token_source` | `"usage"` \| `"estimate"` \| `"unknown"` | `estimate` = tokens inferred from characters, TPS approximate (~±15%) |
| `cache_bust` | `true` | prompt had a unique head nonce → cold-prefill latency, not cache-hit latency |
| `input_tokens` / `output_tokens` | per-request means | the (in, out) coordinates; only compare records with similar coordinates |

Rules of thumb:

- Higher `cache_bust=true` TTFT than an old `protocol_version:"1"` number is **expected**,
  not a regression: v1 numbers from a server with prefix caching describe a warm cache.
- Compare models at the **same** `concurrency`; the ladder runs 1/2/4/8/16/32/64.
- `avg_tps` = total throughput (output tokens over total wall time);
  `avg_output_speed_tps` = speed after the first token.

### Other read endpoints

```bash
curl -s "$BASE/api/dates"                      # ["2026-11-24", ...] newest first
curl -s "$BASE/api/history/2026-11-20"         # [Record] for one date
curl -s "$BASE/api/today"                      # [Record] for today
curl -s "$BASE/api/trend?model=<id>&metric=ttft&concurrency=8"
curl -s "$BASE/api/run-log?limit=20"           # run history, newest first
curl -s "$BASE/api/config"                     # effective ladder, budget, protocol
curl -s "$BASE/healthz"                        # liveness + version + protocol
curl -s "$BASE/api/export.csv?date=2026-11-24" -o day.csv   # CSV for spreadsheets
```

`/api/trend` metrics: `ttft` | `p50` | `p95` | `p99` | `tps` | `output` | `success`.
`concurrency` is optional (omit to aggregate across levels).

## Running a benchmark

```bash
# Whole fleet (returns 409 if a run is already in flight)
curl -s -X POST "$BASE/api/run-test"

# Single model
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"model":"model-a"}' "$BASE/api/run-model"

# Cancel the current run (in-flight requests abort within ~250 ms)
curl -s -X POST "$BASE/api/cancel"
```

Runs are long (a full ladder across several models is minutes, not seconds). Poll
`/api/status` rather than blocking:

```bash
curl -s "$BASE/api/status" | jq '{running, progress, total_requests, completed_requests, models}'
```

`status.models[]` gives per-model `{name, total, completed, status}` where status is
`pending` | `running` | `done` | `error`. Report progress as "3/6 models, 420/2352 requests".

## Reporting guidance

1. Lead with the answer (which model is fastest / did it regress), then the numbers.
2. Always state the caliber: concurrency level, `token_source`, and whether cache busting was on.
3. For comparisons, use the same date+concurrency and mention the (in, out) token coordinates.
4. When citing errors, quote `error_summary` keys verbatim (`"HTTP 429: ..." × 2`).
5. If `dates` has only one entry, say a trend needs more days of data.

## Failure modes

| Symptom | Meaning | Next step |
|---|---|---|
| `409` on `/api/run-test` | a run is already in flight | poll `/api/status` |
| empty `records` but `has_data:false` | model discovered, never tested | offer `POST /api/run-model` |
| `healthz` → 503 / `status:"degraded"` | SQLite unavailable | report infrastructure problem, do not retry blindly |
| all rows `token_source:"estimate"` | gateway rejected `stream_options.include_usage` | numbers are approximate; say so |
| `error_summary` full of 401/403 | upstream credentials | ask the operator to check `API_KEY` |

## Notes

- No authentication: the API is open to whoever can reach the port (bind it to a trusted network).
- The service is read-mostly: `POST` endpoints only trigger/cancel runs, they never mutate
  historical rows (re-running the same day+model+concurrency overwrites that row).
- Do not run benchmarks against endpoints you do not own without permission — a full ladder
  is real load.
