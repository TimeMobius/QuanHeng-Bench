# Health Checker — 前端数据契约 (v2)

本文件是前后端并行开发的唯一事实来源。**后端实现以本文件的字段名为准，前端只依赖本文件**，
不要自行发明字段；如需变更，先改本文件再改代码。

约定：

- 所有 JSON 字段 `snake_case`；时间字符串为本地时间（`TZ_OFFSET_HOURS`），格式 `YYYY-MM-DD HH:MM:SS`。
- 所有数值单位写在字段名里：`_ms` 毫秒、`_tps` token/秒、`_secs` 秒、`_rate`/`success_rate` 百分数 0–100。
- 日期 `YYYY-MM-DD`，并发为正整数。
- 出错时返回对应 HTTP 状态码 + `{"error":"人类可读信息"}`。
- `/api/*` 一律 `Cache-Control: no-store`；`/assets/*`、`/icons/*` 可长缓存。

---

## 1. `GET /api/dashboard?date=YYYY-MM-DD`

`date` 可选，缺省为配置时区的“今天”。一次请求返回整页所需全部数据，前端不得再拼多个接口做首屏。

```json
{
  "date": "2026-08-27",
  "today": "2026-11-20",
  "dates": ["2026-08-27", "2026-08-26"],
  "models": [
    {
      "id": "Qwen3.8-27B",
      "icon": "qwen-color.svg",
      "tested": true,
      "status": "good",
      "has_data": true,
      "records": [ Record, ... ],
      "summary": Summary
    }
  ],
  "summary": Summary,
  "best": {
    "ttft": {"model": "Qwen3.8-27B", "value": 210.5},
    "tps":  {"model": "DeepSeek-V4.1-Flash", "value": 51.2},
    "output_speed": {"model": "MiniMax-M2.7", "value": 60.1},
    "success_rate": {"model": "GLM-5.2", "value": 100.0}
  },
  "status": Status,
  "config": Config,
  "run_log": [RunLog, ...]
}
```

- `models` 顺序：**有数据的模型在前**（按平均 TTFT 升序），未测试的模型在后（按 id 字母序）。
  前端不要重排，除非用户点击排序。
- `status` 字段取值：`good`（全部成功率 ≥ 99）、`warn`（≥ 80 且 < 99）、`bad`（< 80）、`none`（无数据）。
- `has_data` 与 `tested` 冗余保留为同一含义（`tested` 兼容旧模板）。
- `best` 为每个指标表现最好的模型（无数据时为 `null`）。

### Record

```json
{
  "test_date": "2026-08-27",
  "model": "Qwen3.8-27B",
  "concurrency": 8,
  "request_count": 16,
  "error_count": 0,
  "error_summary": {"HTTP 429: rate limited": 2},
  "avg_ttft_ms": 812.3,
  "min_ttft_ms": 640.1,
  "max_ttft_ms": 1200.0,
  "p50_ttft_ms": 800.0,
  "p95_ttft_ms": 1100.0,
  "p99_ttft_ms": 1180.0,
  "avg_output_speed_tps": 42.1,
  "avg_tps": 40.2,
  "total_tokens": 8192,
  "input_tokens": 512.0,
  "output_tokens": 256.0,
  "token_source": "usage",
  "protocol_version": "2",
  "cache_bust": true,
  "success_rate": 99.5,
  "total_duration_secs": 62.4,
  "created_at": "2026-08-27 03:12:44",
  "created_at_local": "2026-08-27 11:12:44"
}
```

- `error_count`：该并发级别的失败请求数（整数，失败请求不进入 TTFT/TPS 统计）。
- `error_summary`：`{错误摘要: 次数}`，最多 5 条，`error_count` 为 0 时是空对象 `{}`。
- `created_at` 保留原始存储值（历史行为），`created_at_local` 为配置时区时间——**界面只显示后者**。
- **protocol v2 口径字段**（v0.3.0 起；历史 v1 记录为默认值）：
  - `input_tokens` / `output_tokens`：每请求平均输入/输出 token（`0` = 该记录无此数据，v1 记录）；
  - `token_source`：`"usage"`（服务端返回 usage，token 实测）| `"estimate"`（字符估算）| `"unknown"`（v1 记录）；
  - `protocol_version`：`"2"` 当前协议，`"1"` 历史数据（含缓存命中、可能纯估算）；
  - `cache_bust`：该记录是否在绕过前缀缓存的口径下测得。
  - 前端必须用徽标标注口径（`实测` / `估算` / `v1`），**不得把不同口径的数字当作同一把尺子连线比较**。

### Summary（记录集合的加权汇总）

```json
{
  "models": 4,
  "models_tested": 3,
  "requests": 512,
  "error_count": 3,
  "tokens": 245760,
  "avg_ttft_ms": 812.3,
  "p95_ttft_ms": 1500.0,
  "avg_output_speed_tps": 42.1,
  "avg_tps": 40.2,
  "success_rate": 97.5,
  "duration_secs": 640.2,
  "max_concurrency": 64
}
```

- `requests` 是**尝试次数**（成功 + 失败），`error_count` 是其中失败的部分，
  `tokens` 只统计成功请求。
- `avg_ttft_ms` / `p95_ttft_ms` / `avg_output_speed_tps` / `avg_tps` 按成功请求数加权；
  `success_rate` 按尝试次数加权（全失败时是 `0`，不是 `null`）。
- `duration_secs` 为各条 `total_duration_secs` 之和。空集合时数值字段为 `null`，`requests`/`tokens` 为 0。

### Status

```json
{
  "running": false,
  "cancel_requested": false,
  "message": "Test completed: 28 records saved",
  "progress": 1.0,
  "total_requests": 660,
  "completed_requests": 660,
  "elapsed_secs": 812.4,
  "started_at": "2026-11-20 11:00:00",
  "last_run": "2026-11-20 11:13:32",
  "last_run_status": "success",
  "models": [
    {"name": "Qwen3.8-27B", "total": 70, "completed": 70, "status": "done"}
  ]
}
```

- `progress` 为 0–1；未运行时 `total_requests`/`completed_requests`/`progress` 可为 `null`。
- 每个模型的 `status`：`pending` | `running` | `done` | `error`。
- `last_run_status`：`success` | `cancelled` | `failed: <原因>` | `null`。

### Config

```json
{
  "base_url": "https://api.example.com",
  "concurrency_levels": [1,2,4,8,16,32,64],
  "requests_per_level": 10,
  "test_runs": 1,
  "questions_per_run": 20,
  "max_tokens": 512,
  "request_timeout_secs": 1800,
  "timezone_offset_hours": 8,
  "scheduled": {"hour": 3, "minute": 0, "cron_utc": "0 0 19 * * * *"},
  "models_cache_secs": 60,
  "cancel_supported": true,
  "version": "0.1.0"
}
```

### RunLog

```json
{
  "id": 12,
  "started_at": "2026-11-20 11:00:00",
  "finished_at": "2026-11-20 11:13:32",
  "duration_secs": 812.4,
  "mode": "full",
  "target": null,
  "status": "success",
  "message": "Test completed: 28 records saved",
  "record_count": 28
}
```

- `mode`: `full` | `model`；`target` 在 `model` 模式下为模型 id。
- `status`: `running` | `success` | `failed` | `cancelled`。

---

## 2. `GET /api/status`
返回上面的 `Status` 对象（轮询用，2s 一次）。

## 3. `POST /api/run-test`
触发全量测试。`202 {"message":"Test started"}`；正在运行时 `409 {"error":"test already running"}`。

## 4. `POST /api/run-model`
Body `{"model":"<id>"}`。`202`；模型为空 `400`；正在运行 `409`。

## 5. `POST /api/cancel`
请求停止当前测试（请求级检查，最多损失一个在途请求批次）。
`202 {"message":"cancel requested"}`；未运行 `409 {"error":"no test running"}`。

## 6. `GET /api/models?refresh=1`
模型列表带缓存（默认 60s）。`refresh=1` 强制刷新。

```json
{"models":[{"id":"Qwen3.8-27B","owned_by":null,"created":null}],
 "fetched_at":"2026-11-20 11:20:00","cached":true,"error":null}
```

上游不可用时返回 `200` + `{"models":[],"error":"..."}`（页面不应因上游故障而失败）。

## 7. `GET /api/trend?model=<id>&metric=<m>&concurrency=<n>`
`metric` ∈ `ttft|p50|p95|p99|tps|output|success`；`concurrency` 省略时按请求数加权汇总所有并发。

```json
{"model":"Qwen3.8-27B","metric":"ttft","concurrency":8,
 "points":[{"date":"2026-08-27","value":812.3,"request_count":16,"success_rate":99.5}]}
```

`points` 按日期升序。无数据时 `points: []`。

## 8. `GET /api/export.csv?date=YYYY-MM-DD&model=<可选>`
`text/csv; charset=utf-8`，`Content-Disposition: attachment; filename="quanheng-bench-<date>[-<model>].csv"`。
列顺序：

```
date,model,concurrency,request_count,error_count,success_rate,avg_ttft_ms,min_ttft_ms,p50_ttft_ms,p95_ttft_ms,p99_ttft_ms,max_ttft_ms,avg_output_speed_tps,avg_tps,total_tokens,total_duration_secs,created_at
```

值不加单位，浮点保留 3 位；`model` 被过滤时文件名带模型名（不安全字符替换为 `_`）。
> protocol v2 的 `input_tokens` / `output_tokens` / `token_source` / `protocol_version` / `cache_bust`
> 目前只走 JSON 接口；CSV 保持既有列顺序以免破坏下游解析（如需导出请自行查库或等 P1 的 `--format` 选项）。

## 9. `GET /api/config`
返回上面的 `Config`。protocol v2 追加字段：

```json
{
  "output_tokens": 512,
  "input_tokens": 0,
  "stream_include_usage": "auto",
  "cache_bust": true,
  "warmup_requests": 2,
  "protocol_version": "2"
}
```

- `stream_include_usage`：`"auto"` | `"on"` | `"off"`（字符串，不是布尔——v2 起为三态）；
- `output_tokens`：实际生效的输出预算（`OUTPUT_TOKENS` 优先，否则 `MAX_TOKENS`）；
- `warmup_requests`：`cache_bust` 关闭时为 `0`。

## 10. 兼容接口（保留，语义不变）
- `GET /api/today` → `[Record]`（今天）
- `GET /api/history/:date` → `[Record]`
- `GET /api/dates` → `["2026-08-27", ...]` 倒序
- `GET /api/run-log?limit=20` → `[RunLog]`（倒序）

## 11. 页面路由
- `GET /` → 仪表板外壳（`templates/dashboard.html`），由 JS 渲染数据。
- `GET /history/:date` → 同一外壳，预置日期（`templates/history.html`）。
- `GET /assets/*`、`GET /icons/*` → 静态文件。

页面外壳里会注入：
```html
<body data-page="dashboard" data-date="2026-08-27" data-today="2026-11-20" data-base-url="...">
```
（`data-date` 为空表示“今天”。）JS 以 `data-page` 区分入口，不要另外请求配置就能拿到日期。

---

# 前端 UI 规格（与后端解耦，供 UI 实现参考）

## 信息架构（单页，hash 路由）

| 视图 | hash | 内容 |
|---|---|---|
| 概览 | `#/overview` | KPI 卡（模型数/请求数/平均 TTFT/P95/输出速度/成功率/总 token）、模型状态列表 + 最小柱状图、今日最佳、运行状态条 |
| 模型 | `#/model/<id>` | 该模型完整表格（可排序、显示 min/max/错误数/成功率条）、4 张图（TTFT、延迟分位、吞吐双轴、成功率）、CSV 导出、单独重测 |
| 对比 | `#/compare?models=a,b` | 多模型选择器；TTFT/TPS 多曲线叠加；归一化雷达图；对比表格 |
| 趋势 | `#/trend?model=a&metric=ttft&concurrency=8` | 跨日期折线、指标/并发切换、日期范围 |
| 运行记录 | `#/runs` | 运行日志表 + 手动触发/取消、自动刷新开关 |
| 历史 | 日期选择器（全局） | 侧栏/顶部日期列表带搜索，切换即更新 `?date=` 并重渲染（不整页刷新） |

要求：

1. **不做整页刷新**：测试完成时只拉 `/api/dashboard` 重渲染；保留当前视图/模型/滚动位置。
2. **图表数据必须来自 JSON**，禁止再解析 `td.textContent`。
3. 并发轴为指数序列（1,2,4,8,16,32,64），折线图用 `type:'logarithmic'`（或等距 category 轴并标注真实并发），
   保证低并发区间可读。
4. 浅色/深色主题：`prefers-color-scheme` 默认 + 手动切换（`localStorage`），Chart.js 颜色跟随 CSS 变量。
5. 可访问性：tab 用 `role="tablist"/"tab"/"tabpanel"` + 方向键切换；表格 `scope="col"`；图表容器 `role="img"` + `aria-label`；焦点可见。
6. 响应式：≤900px 时 KPI 两列、表格横向滚动、图表高度 320px。
7. 数字格式：千分位用 `,`（`84,480`，与 `toLocaleString('zh-CN')` 一致）、TTFT ≥ 1000ms 显示 `1.23 s`、
   token 用 `k/M` 缩写（tooltip/`title` 保留精确值）。
8. 空状态/错误状态/加载骨架三态齐全；网络错误用 toast，不要静默。
9. CSS/JS 全部外置到 `assets/`，模板里不允许出现 `<style>` 与内联事件处理器（`onclick=`）。
10. 不引入构建步骤：原生 ES Module + 既有 Chart.js 4.4.7（`/assets/vendor/chart.js/chart.umd.min.js`），
    通过 `<script type="module">` 加载 `assets/js/main.js`。
