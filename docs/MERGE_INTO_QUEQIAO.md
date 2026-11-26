# 把 Health Checker 并入 QueQiao-Router 的可行性评估

> 评估日期：2026-11-21 · 评估基线：Health_Checker `18118f2`（v0.2.0）、QueQiao-Router `main`（`0.2.722`）
> 方式：读代码 + 只读解析 `../config.yaml` + 对后端做单次流式探针（每后端 1 个请求、`max_tokens=16`）。
> 本文只做方案评估，**没有修改 QueQiao-Router 的任何文件**。

## 0. 结论（TL;DR）

**可行，而且契合度比预期高**：两边都是 Rust + Axum 0.7 + reqwest 0.12（rustls）+ SQLite，
QueQiao 已有现成的 Dashboard（rust-embed + ECharts）、每后端模型缓存、日调度工具、审计库与 Prometheus 指标。
合并后得到的是"一个镜像、一个面板、按后端出性能成绩单"，这是当前独立部署**做不到**的（见 §2 实测）。

但**不能原样搬**，有三处必须重新设计：

| # | 现状（Health Checker） | 合并后必须变成 | 原因 |
|---|---|---|---|
| 1 | 测一个 `BASE_URL`（= 网关自己） | 测「后端矩阵」：直连每个 backend，可选经网关 | 网关是随机路由，测不出“哪个后端慢”；QueQiao 的资产就是多后端 |
| 2 | `rusqlite`（同步、bundled） | `sqlx` + 独立 `benchmark.db` | QueQiao 全量用 sqlx/turso；审计库按月轮转，压测结果不该被牵连 |
| 3 | Minijinja + Chart.js SPA | QueQiao `web/` 页面 + ECharts | 同一面板里两套图表库不划算 |

工作量：**1 人约 8–12 个工作日（4 个 PR）**；风险中等，最大风险是"对生产后端加压"和"污染审计/指标"，都有明确护栏（§10）。

## 1. 两边现状对比

| 维度 | Health Checker | QueQiao-Router | 合并结论 |
|---|---|---|---|
| 语言/框架 | Rust 2021 + Axum 0.7 | Rust 2021 + Axum 0.7 | 同构，代码可直接迁 |
| HTTP 客户端 | reqwest 0.12 + rustls | reqwest 0.12 + rustls + 连接池（`ConnectionPoolConfig`） | 复用 QueQiao 的 `ClientManager` |
| 存储 | rusqlite（同步，`spawn_blocking`） | sqlx 0.7 + turso 0.8（异步）+ 月度轮转/归档 | 新增 sqlx 存储层 |
| 配置 | 纯环境变量 | YAML + 热重载（`ConfigManager`） | 新增 `benchmark:` 段 |
| 调度 | `tokio-cron-scheduler` | 自研 `schedule::parse_hhmm/next_daily_after`（已用于 nightly archive / rollup） | 直接复用，不再引新依赖 |
| 模型列表 | `/v1/models` + 60s 缓存 | 每后端 `ModelsCache`（TTL、单飞、stale 兜底） | 复用，删掉重复实现 |
| 前端 | Minijinja + 原生 ESM + Chart.js 4.4.7 | rust-embed + `shell.css/shell.js` + ECharts 5 | 页面并入 `/dashboard`，图表改 ECharts |
| 可观测性 | 主动压测结果（TTFT/TPS/成功率/错误摘要） | 被动 per-request 指标（TTFT/TPS 直方图、1m/10m/1h 滑窗、审计明细） | **互补**：被动看现状，主动做基线对比 |
| 鉴权 | 无 | 可选 `check-api-auth` feature（`../Check_API`）；`/dashboard` 默认无鉴权 | 压测写接口必须加 token/loopback |
| 部署 | 单二进制（模板内嵌）+ 双架构镜像 | 单二进制（web 内嵌）+ 多架构 CI（native runner 矩阵） | 合并为一个镜像 |

底座规模：QueQiao 约 34.8k 行 Rust / 114 个源文件，`/dashboard` 已有 3 个页面 + 7 个 JSON API；
Health Checker 需要迁移的净逻辑约：引擎 800 行 + 存储 250 行 + API 350 行 + 前端 1.2k 行。**占比很小，不会破坏 QueQiao 的主链路。**

## 2. 本次实测：为什么"独立部署"测不出真问题

只读解析 `../config.yaml`：**13 个后端，9 个无 api_key（内网/透传），4 个带 key**，模型名以 `exact` 匹配为主。
从本开发机（192.0.2.31）做单次流式探针：

| 后端 | base_url | 结果 |
|---|---|---|
| `DeepSeek-V4.1-Flash` | `http://192.0.2.11:8000/v1` | ✅ 200，TTFB 2355 ms，总 8607 ms（16 tokens，内容为空说明走 reasoning 字段） |
| `qwen38` | `http://192.0.2.12:8000/v1` | ❌ Connection refused（该后端当前未起来） |
| `xiaoke5` | `http://192.0.2.21:32718/v1` | ❌ No route to host（网段不可达） |
| `hapi-OpenAI` | `https://hapiopen.cc/v1` | ❌ 401（**依赖客户端透传 key**，配置里没有后端 key） |

三条结论直接决定架构：

1. **压测必须跑在 QueQiao 进程内**（或同主机同网络命名空间）。独立部署哪怕放同一台机器，也要处理网段/端口/密钥三件事，而且拿不到 `api_key_priority` 的透传语义。
2. 对**无 key 的后端**，压测要么用配置里的 key，要么在 `benchmark:` 段单独给一个"压测专用 key"，要么只能走网关（由客户端带 key）。
3. Health Checker 现在测的 `BASE_URL`（`https://api.example.com`）是**网关**，一次请求可能落到任一后端；它的"模型排行"其实是"路由结果排行"，无法回答"192.0.2.11 和 192.0.2.21 谁快"。

## 3. 三种落地形态

### 方案 A：模块化合并（推荐）

在 QueQiao 内新增一个**可选模块**（默认关闭），复用网关的客户端/模型缓存/面板：

```
config.yaml (benchmark:)
        │
        ▼
BenchmarkPlanner ──► TargetResolver ──► Engine (worker pool + SSE 行缓冲 + 取消)
        │                │                     │
        │                ├── backend:<name>     ▼
        │                │   直连 base_url   Aggregator（分位/成功率/错误摘要）
        │                └── gateway          │
        │                    经 /v1/chat      ▼
        └── 日调度 (schedule)            benchmark.db (sqlx)
                                              │
                                    /dashboard/api/benchmark/*
                                              │
                                    /dashboard/benchmark (ECharts)
```

- 优点：一个镜像、一套鉴权/日志/指标；能出"后端 × 模型 × 并发"矩阵；复用 `ClientManager` 连接池（压测结果更接近真实网关行为）。
- 代价：动 QueQiao 的 `config/types.rs`、`routes/dashboard.rs`、`web/`，需要遵守其 schema/测试/版本规范。
- 工期：8–12 人日。

### 方案 B：同镜像双进程（sidecar-in-container）

镜像里用 supervisor 同时跑 `queqiao-router` 与 `health-checker`，共享 host 网络，Dashboard 用 iframe/反代挂载。

- 优点：改动最小（1–2 天），Health Checker 现有代码/面板原样复用。
- 缺点：两个 SQLite、两套日志、两套鉴权、两套升级节奏；端口/健康检查/资源限制都要额外配；**仍然是两张皮**。
- 适用：只想一周内上线、暂不追求 UI 统一。

### 方案 C：不合并，做"后端矩阵"适配（最小验证）

Health Checker 增加一个可选配置源：只读 QueQiao 的 `config.yaml`（或用 QueQiao 新增的只读 `/dashboard/api/backends`），
按 backend 直连跑矩阵；部署时用 `--network=host` 与 QueQiao 同机。

- 优点：0 改动 QueQiao，先把"按后端出成绩单"的价值验证出来。
- 缺点：跨机器/跨网段依旧不可达；密钥语义要复制一份；长期仍是两个服务。

**建议**：先用 **C 做 2 天价值验证**（确认"后端矩阵"确实是你们要的），再走 **A**；B 只在"必须一周内上线"时选。

## 4. 合并后的数据模型（独立 `benchmark.db`，sqlx）

```sql
-- 每次运行一条
bench_runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,        -- 本地时间 YYYY-MM-DD HH:MM:SS
  finished_at TEXT,
  duration_secs REAL,
  mode TEXT NOT NULL,              -- backend | gateway | both
  target TEXT,                     -- backend 名；gateway 模式为 NULL
  status TEXT NOT NULL,            -- running | success | failed | cancelled
  message TEXT,
  record_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0
);

-- 每个 (日期, 目标, 模型, 并发) 一条，当天重复运行覆盖（保留 runs 做审计）
bench_results(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_date TEXT NOT NULL,
  target TEXT NOT NULL,            -- backend 名 / gateway
  model TEXT NOT NULL,
  concurrency INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT NOT NULL DEFAULT '{}',
  avg_ttft_ms REAL NOT NULL, min_ttft_ms REAL NOT NULL, max_ttft_ms REAL NOT NULL,
  p50_ttft_ms REAL NOT NULL, p95_ttft_ms REAL NOT NULL, p99_ttft_ms REAL NOT NULL,
  avg_output_speed_tps REAL NOT NULL DEFAULT 0,
  avg_tps REAL NOT NULL,
  total_tokens INTEGER NOT NULL,
  success_rate REAL NOT NULL,
  total_duration_secs REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(test_date, target, model, concurrency)
);
CREATE INDEX idx_bench_date ON bench_results(test_date);
CREATE INDEX idx_bench_target ON bench_results(target, test_date);
PRAGMA user_version = 1;          -- 迁移沿用 Health Checker 的 ensure_column 思路
```

保留策略：默认 90 天（`retention_days`），每日调度后清理；`bench_runs` 保留 1000 条。

## 5. API 契约（挂在 `/dashboard/api/benchmark`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/targets` | 可用目标（来自 config）：backend 名、脱敏 base_url、模型列表、是否可直连、是否配了 key |
| GET | `/overview?date=` | 整页数据：结果、加权汇总、最佳/最差、runs、status、config |
| GET | `/status` | 运行状态（总进度 + 每个目标/模型进度 + 是否已请求取消） |
| POST | `/run` | `{mode, targets?, levels?, runs?}` → 202；运行中 409 |
| POST | `/cancel` | 取消（请求级检查，≤250ms 生效） |
| GET | `/trend?target=&model=&metric=&concurrency=` | 跨日期趋势 |
| GET | `/export.csv?date=&target=&model=` | CSV 导出 |
| GET | `/run-log?limit=` | 运行日志 |

字段沿用 Health Checker 的 `docs/API_CONTRACT.md`（`/api/dashboard` 结构），只多一层 `target` 维度；
前端迁移时数据层几乎不用改。

## 6. 配置段（YAML）

```yaml
benchmark:
  enabled: false                    # 默认关闭，避免误压生产
  schedule: "03:00"                 # 本地时间；"off" 关闭定时
  mode: "backend"                   # backend | gateway | both
  targets: ["*"]                    # 白名单：backend 名，或 "*"
  concurrency_levels: [1, 2, 4, 8, 16, 32, 64]
  requests_per_level: 10            # 每级下限（band 与它取大）
  test_runs: 1
  questions_per_run: 20
  max_tokens: 512
  stream_include_usage: false
  max_parallel_targets: 4           # 同时压几个 backend（总并发 ≈ 该值 × 并发级别）
  request_timeout_secs: 300
  api_key: null                     # 仅给"无 key 后端"直连压测用；null 表示复用后端配置
  db_path: "./data/benchmark.db"
  retention_days: 90
  admin_token_env: "BENCHMARK_ADMIN_TOKEN"
  mark_gateway_requests: true       # gateway 模式加 X-QueQiao-Bench:1，供审计/指标过滤
```

热重载：`BenchmarkPlanner` 在**每次运行开始时**从 `ConfigManager` 取快照，运行中不热更（避免半途改并发）。

## 7. 需要动的文件（预估）

| 文件 | 改动 | 行数 |
|---|---|---|
| `src/config/types.rs` | 新增 `BenchmarkConfig` + `Config.benchmark` | +50 |
| `src/services/benchmark/mod.rs` | 模块入口 | +20 |
| `src/services/benchmark/engine.rs` | worker 池、SSE 行缓冲、取消、聚合（从 Health Checker 迁移） | ~600 |
| `src/services/benchmark/target.rs` | 目标解析：backend（base_url/key/model_rewrite）/ gateway | ~150 |
| `src/services/benchmark/questions.rs` | 题库（可直接复用现有 510 题） | ~20（include） |
| `src/db/benchmark.rs` | sqlx 建表/迁移/upsert/查询/清理 | ~250 |
| `src/handlers/benchmark_api.rs` | 7 个端点 + token 校验 | ~350 |
| `src/routes/dashboard.rs` / `mod.rs` | 挂载页面与 API | +12 |
| `web/benchmark.html` + `web/assets/benchmark.js` | 概览/模型/对比/趋势/运行记录（ECharts） | ~1200 |
| `web/index.html` 等 | 导航加一项 | +2 |
| 测试 | 引擎/聚合/存储/API/token | ~400 |
| 文档 | `AGENTS.md`/`README.md`/`DEVELOPER.md` + config 样例 | ~120 |

## 8. 分阶段计划与验收

| 阶段 | 内容 | 工期 | 验收（可量化） |
|---|---|---|---|
| **P0 冒烟** | feature flag + `POST /dashboard/api/benchmark/run`（仅 backend 模式、单级别）+ sqlx 落库 | 1d | 直连 `DeepSeek-V4.1-Flash` 跑 3 个请求，DB 有 1 行结果，进程无 panic |
| **P1 引擎+面板** | 完整并发级别、取消、进度、overview/model 视图 | 3–4d | 7 个级别 × 3 模型跑完；取消 250ms 内生效且无半套记录；面板与 DB 数值一致 |
| **P2 对比/趋势/导出/调度** | compare/trend/runs、CSV、每日调度、保留清理 | 2–3d | 30 天趋势可查；CSV 行数 = 记录数；调度只跑一次 |
| **P3 网关模式 + 打标** | `mode: gateway/both`、`X-QueQiao-Bench`、审计/指标排除 | 2d | 网关模式下审计可按 header 过滤；bench 指标独立 prefix |
| **P4 收尾** | 文档、镜像、双架构、回归 | 1d | `cargo fmt/build/test` 全绿；amd64/arm64 镜像冒烟；README 一节 |

## 9. 与既有能力的去重（合并时删掉的东西）

- Health Checker 的 `ModelsCache` → 用 QueQiao `services::models_cache`（TTL/单飞/stale 已有）。
- Health Checker 的 `TestRunner.client` → 用 `ClientManager`（连接池参数与网关一致，结果更具可比性）。
- Health Checker 的 cron 依赖（`tokio-cron-scheduler`）→ 删，改用 `schedule::next_daily_after`。
- Health Checker 的 Minijinja 模板与 `build.rs` 模板嵌入 → 删，改用 rust-embed `web/`。
- Health Checker 的 CORS/安全头中间件 → 用 QueQiao 现有中间件（注意 QueQiao 目前是 `allow_origin(Any)`，压测接口不要继承）。
- Health Checker 的独立调度/运行锁 → 复用 `AppState` 里新增的 `bench_run_active: AtomicBool`。

## 10. 风险与护栏

| 风险 | 影响 | 对策 |
|---|---|---|
| 压测打到生产后端 | 真实用户受影响、上游账单 | `enabled=false` 默认关；`targets` 白名单；`max_parallel_targets`；单次总请求预算（`max_total_requests`）；只允许 off-peak 调度；`dry-run` 只算计划不发请求 |
| 审计/指标污染 | 日志分析失真 | gateway 模式打 `X-QueQiao-Bench: 1`；审计写入前过滤；Prometheus 用 `queqiao_bench_*` 独立前缀 |
| 无 key 后端直连失败 | 结果缺失 | `benchmark.api_key` 兜底；`/targets` 明确标出“不可直连/需要 key” |
| 网络分段 | 部分后端不可达 | 压测只在进程内执行；`/targets` 标注最近一次探测结果 |
| DB 轮转/归档冲突 | 数据丢失 | 独立 `benchmark.db`，不进审计轮转；保留策略自己管 |
| 面板无鉴权 + CORS Any | 任意站点触发压测 | 写接口要求 `Authorization: Bearer $BENCHMARK_ADMIN_TOKEN` 或仅 loopback；CORS 不收窄也不要给 `/api/benchmark` 放开 |
| 版本节奏 | 合并 PR 与 CI tag 冲突 | 拆 4 个 PR，每个都过 `cargo fmt/build/test` 与现有测试 |
| 前端两套图表库 | 体积/风格分裂 | 统一 ECharts；过渡期可以先 iframe 现有 SPA（方案 B 的 UI 部分），P2 再重写 |

## 11. 额外收益（顺手能做的）

- QueQiao 的 CI 用 native arm runner 矩阵构建双架构；Health Checker 的 **QEMU-free 交叉编译 Dockerfile**（见 `Dockerfile` 的 `builder/runtime-files/runtime` 三段）可以简化其 CI（去掉 arm runner，只用 amd64 构建两个平台）。
- 合并后可以把"压测结果"写进 Prometheus（`queqiao_bench_ttft_seconds{backend,model,concurrency}`），让 Grafana 直接看历史基线。
- 反向也能受益：Health Checker 的 `SseLineBuffer`（按字节行缓冲、防跨 chunk 丢帧）可以对照 QueQiao 的 `eventsource-stream` 实现做一次流健壮性回归测试。

## 12. 如果现在就要开始：第一个 PR 的建议内容

1. `config/types.rs` 加 `BenchmarkConfig`（只含 enabled/schedule/mode/targets/db_path/retention），默认关闭。
2. 新建 `src/services/benchmark/`，先把"目标解析 + 单请求流式测量 + 聚合"从 Health Checker 移植过来（不接 UI）。
3. `src/db/benchmark.rs`：sqlx 建 `bench_runs/bench_results`，`PRAGMA user_version=1`，单测覆盖 upsert 与保留清理。
4. `POST /dashboard/api/benchmark/run`：只支持 `mode=backend` + 单 level，token 校验 + 409 运行锁。
5. 验收：对内网 `DeepSeek-V4.1-Flash` 跑 3 个请求，DB 落 1 行，`cargo test` 全绿。
   —— 这一步能回答所有架构疑问，且可随时丢弃，不触碰主链路。
