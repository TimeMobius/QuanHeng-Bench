# QuanHeng-Bench（权衡·基准）— LLM API 性能测试工具

## 项目概况

QuanHeng-Bench 是一个 Rust 编写的 LLM API 性能测试与可视化工具，定位是**不同内网、不同配置部署模型的度量衡**：
同协议测量、跨环境对比、长期基线。  
它针对配置的 OpenAI 兼容 API 端点，获取模型列表，对每个模型在不同并发级别下执行压力测试，测量 TTFT（首 Token 延迟）和 TPS（吞吐量），并将结果持久化到 SQLite，通过 Web 仪表板展示。

### 核心工作流

1. 请求 `{BASE_URL}/v1/models` 获取可用模型列表（结果缓存 `MODELS_CACHE_SECS` 秒，默认 60）
2. **协商 usage 能力**（`STREAM_INCLUDE_USAGE=auto` 时）：一次性廉价探针（`max_tokens=1` + 请求 usage），
   成功则本进程内所有请求都带 `stream_options.include_usage`（精确 token）；
   网关 4xx 拒绝未知字段则回落估算口径。结果写入 `endpoint_capabilities`，跨重启复用。
3. **模型级预热**：以单并发跑 `WARMUP_REQUESTS` 个请求，结果完全丢弃（不计时/不统计/不写库），
   只吸收一次性的冷启动开销（权重加载、CUDA graph 捕获、kernel 编译）
4. 从内置 510 题题库中随机抽题——**每个并发级别独立抽一组**（跨级别不复用，配合 nonce 破坏前缀缓存）
5. 对**每个模型**并行执行测试（模型间并发；`MAX_PARALLEL_MODELS` 限制同时测试的模型数，默认 8）
6. 每个模型依次在 7 个并发级别（1/2/4/8/16/32/64）下测试
7. 每个并发级别跑 `TEST_RUNS` 轮取平均值
8. 每轮请求数 = `max(band(并发), REQUESTS_PER_LEVEL)`，
   band = 并发×3（≤4）/ 并发×2（≤16）/ 并发×1（>16），保证低并发也有足够样本算 P99；
   每档至少 2 波（`TEST_RUNS=2` 天然满足），供饱和判定使用
9. **构造 prompt**：按 `INPUT_TOKENS` 目标长度填充或截断题目；`CACHE_BUST=1` 时在 prompt **头部**
   插入唯一 nonce（`# qh-<epoch>-<seq>`）——前缀 KV 缓存从头匹配，头部不同即全 prompt 不可复用。
   nonce 必须放头部，放尾部无效。
10. 流式解析 SSE 响应：**按行缓冲**（跨网络 chunk 的半行不会丢），捕获 `usage.completion_tokens` 算精确 TPS；
   服务器不返回 usage 时按字符估算（CJK 1 字≈1 token，其他非空白 ~4 字符/token）
11. 记录 TTFT（首 token，检测 `reasoning`/`reasoning_content`/`content` 三个字段）
12. 输出速度分两口径：首字后输出速度、整体吞吐
13. 失败请求单独计数，并按错误摘要聚合（`error_count` / `error_summary`，只落库最多 5 类）
14. 结果写入 SQLite（`test_records`），每条记录带 **token 口径元数据**：
    `input_tokens` / `output_tokens`（每请求均值）、`token_source`（`usage` 实测 / `estimate` 估算）、
    `protocol_version`（`2`；历史 v1 数据为 `1`）、`cache_bust`。每次运行写一条 `run_log`
15. 运行中可通过 `POST /api/cancel` 取消（请求级检查，≤250ms 生效，未完成的并发级别不落库）
16. Web 页面实时展示：概览 / 模型详情 / 多模型对比 / 跨日期趋势 / 运行记录

### 测量协议（protocol v2）

同一份数据要么同口径可比，要么必须标明口径。v2 与历史 v1 的差异：

| 项 | v1（历史数据） | v2（当前） |
|---|---|---|
| token 来源 | 默认不请求 usage，纯字符估算 | auto 协商，能拿真实 usage 就拿 |
| 前缀缓存 | 未处理，开缓存的服务器上多为缓存命中口径（TTFT 偏低） | 头部 nonce 绕过，测冷 prefill |
| 抽题 | 全流程复用同一组题 | 每并发级别独立抽题 |
| 预热 | 无 | 模型级单并发预热，独立阶段、不计时不计统计 |
| 输入/输出规模 | 题库题目随机长度 + `MAX_TOKENS` | `INPUT_TOKENS` / `OUTPUT_TOKENS` 固定坐标 |
| 记录标记 | 无 | `protocol_version` / `token_source` / `cache_bust` |

> 趋势图里 v1 与 v2 数据不建议直接连线比较；界面用 `协议 v2` / `实测` / `估算` 徽标标注口径。

### 技术栈

| 层 | 选型 |
|---|---|
| 语言 | Rust (edition 2021) |
| Web 框架 | Axum 0.7 |
| 模板 | Minijinja 2.x（`{% extends %}` + `build.rs` 自动嵌入 `templates/`） |
| HTTP 客户端 | reqwest 0.12 (流式 SSE) |
| 数据库 | SQLite via rusqlite (bundled) |
| 定时任务 | tokio-cron-scheduler |
| 前端 | 原生 ES Module + CSS 变量（无构建步骤、无 CDN） |
| 前端图表 | Chart.js 4.4.7（本地 `assets/vendor/`） |
| 容器 | Docker multi-stage + buildx 交叉编译 |

---

## 快速开始

### 前置条件

- Rust 工具链 (1.78+)
- Docker + buildx (用于多平台构建)
- 一个 OpenAI 兼容的 API 端点

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BASE_URL` | `http://localhost:8000` | LLM API 基础地址 |
| `API_KEY` | (空) | Bearer 认证密钥 |
| `HOST` | `0.0.0.0` | Web 服务监听地址 |
| `PORT` | `3000` | Web 服务端口 |
| `DB_PATH` | `/app/data/records.db` | SQLite 数据文件路径 |
| `CONCURRENCY_LEVELS` | `1,2,4,8,16,32,64` | 并发级别（逗号分隔） |
| `REQUESTS_PER_LEVEL` | `10` | 每级请求数**下限**（与 band 公式取较大值，`0` = 只用 band） |
| `MAX_PARALLEL_MODELS` | `8` | 同时测试的模型数上限（1–32）；总并发 ≈ 该值 × 并发级别 |
| `MODELS_CACHE_SECS` | `60` | `/v1/models` 列表缓存秒数（`/api/models?refresh=1` 可强制刷新） |
| `STREAM_INCLUDE_USAGE` | `auto` | `auto`（默认）= 每次运行前一次性探测端点是否支持 `stream_options.include_usage`，支持则精确 usage、4xx 拒绝则回落估算，结果持久化到 `endpoint_capabilities`；`true` 强制发送；`false` 从不发送 |
| `CACHE_BUST` | `true` | 前缀缓存绕过：每个请求在 prompt 头部插入唯一 nonce + 按并发级别轮换抽题。关闭则为 v1 口径（含缓存命中，TTFT 偏低） |
| `WARMUP_REQUESTS` | `2` | **模型级**一次性预热请求数（单并发），在所有档位测量之前跑完；完全不计时、不计统计、不写库。各并发档不再预热 |
| `INPUT_TOKENS` | `0` | 目标输入长度（token）。`0` = 直接用题库题目；>0 时按 `token × 4` 字符填充/截断（无 tokenizer，偏差约 ±15%） |
| `OUTPUT_TOKENS` | `0` | 输出 token 预算；`0` = 用 `MAX_TOKENS`。同时决定请求体 `max_tokens` |
| `CORS_ORIGINS` | (空) | 逗号分隔的允许来源；为空 = 仅同源（不再 `allow_origin(Any)`） |
| `RUN_ON_START` | `true` | 启动时若当天无数据则自动跑一次；本地调试建议 `false` |
| `ASSETS_DIR` | (自动探测) | 静态资源目录；依次探测 `ASSETS_DIR` → `./assets` → `/app/assets` → 源码树 |
| `TEST_RUNS` | `2` | 每级测试轮数（取均值）。单轮只有 1 个样本，无法区分「真并行」和「只是还没排队」 |
| `QUESTIONS_PER_RUN` | `20` | 每次随机抽题数 |
| `MAX_TOKENS` | `512` | 模型输出最大 token |
| `REQUEST_TIMEOUT_SECS` | `1800` | 单次请求超时 |
| `TZ_OFFSET_HOURS` | `8` | 定时测试时区偏移 |
| `SCHEDULED_HOUR` | `3` | 定时执行小时（本地时间） |
| `SCHEDULED_MINUTE` | `0` | 定时执行分钟 |

---

## 编译与测试

### 本地编译

```bash
# debug 构建
cargo build

# release 构建（推荐）
cargo build --release

# 编译产物
# target/release/quanheng
```

### 运行测试

```bash
# 单元测试
cargo test

# 快速启动一次测试（覆盖小规模，验证功能；RUN_ON_START=false 避免启动即压测）
RUN_ON_START=false \
  CONCURRENCY_LEVELS=1,2 \
  REQUESTS_PER_LEVEL=2 \
  TEST_RUNS=1 \
  QUESTIONS_PER_RUN=5 \
  MAX_TOKENS=100 \
  RUST_LOG=info \
  cargo run --release

# 全量生产运行
cargo run --release
# 访问 http://localhost:3000
```

### 代码检查

```bash
# cargo check 快速编译检查
cargo check

# clippy 代码质量检查（含测试目标）
cargo clippy --all-targets -- -D warnings

# Rust 编译器版本
rustc --version
# 要求 >= 1.78
```

### 项目结构

```
quanheng-bench/
├── Cargo.toml              # 依赖与构建配置
├── build.rs                # 构建期：把 templates/ 下所有 .html 嵌入二进制
├── Dockerfile              # 多阶段多架构 Docker 构建
├── .dockerignore           # 构建上下文裁剪
├── build.sh                # 多平台 Docker 镜像构建脚本
├── docker-compose.yml      # 本地快速部署
├── AGENTS.md               # 本文件
├── skills/quanheng-bench/
│   └── SKILL.md            # 给 AI 读的接口说明（何时调用、口径字段、触发/轮询）
├── docs/
│   ├── REVIEW.md           # 代码审查报告（问题清单 + 路线图）
│   ├── API_CONTRACT.md     # 前端数据契约（接口字段的唯一事实来源）
│   ├── MERGE_INTO_QUEQIAO.md # 合并进 QueQiao-Router 的可行性评估与落地方案
│   ├── OPEN_SOURCE_PLAN.md # 独立开源的方向决策、命名、发布前清单与两周计划
│   ├── screenshots/        # 各视图截图（浅色/深色/移动端）
│   └── fixtures/           # 前端联调用的样例 JSON
├── src/
│   ├── main.rs             # 入口：服务器启动、cron 调度、优雅关闭
│   ├── config.rs           # 环境变量配置（集中式、fail-fast）+ 请求数策略
│   ├── models.rs           # 共享数据类型、DTO、加权汇总
│   ├── db.rs               # SQLite（WAL、user_version 迁移、upsert、run_log）
│   ├── tester.rs           # 核心测试引擎（worker 池并发、SSE 行缓冲、取消）
│   ├── routes.rs           # Axum 路由、JSON API、CSV 导出、模板外壳
│   └── questions.rs        # 510 道测试题库（12 个领域）
├── templates/
│   ├── base.html           # 母版（head / 主题 / 骨架屏 / 脚本入口）
│   ├── partials/           # header、footer
│   ├── dashboard.html      # 仪表板外壳（数据由 JS 拉 /api/dashboard 渲染）
│   └── history.html        # 指定日期的同一外壳
├── assets/
│   ├── css/app.css         # 设计 token、深浅色、响应式
│   ├── js/                 # 原生 ES Module：api/store/charts/views/...
│   └── vendor/chart.js/    # 本地 Chart.js 4.4.7
├── icons/                  # 模型厂商图标（静态）
└── data/                   # SQLite 数据持久化目录（gitignore）
```

---

## Docker 构建与发布

### 单架构构建（快速本地测试）

```bash
# 直接使用本地已编译的二进制构建（跳过 Rust 编译）
cp target/release/quanheng /tmp/quanheng-bin
strip /tmp/quanheng-bin

cat > /tmp/Dockerfile.fast << 'DOCKEREOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
RUN ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && echo "Asia/Shanghai" > /etc/timezone
WORKDIR /app
COPY quanheng-bin /app/quanheng
# 运行时静态资源（CSS/JS/Chart.js 与模型图标）不是内嵌的，必须一起复制
COPY assets/ /app/assets/
COPY icons/ /app/icons/
RUN mkdir -p /app/data
EXPOSE 3000
ENV BASE_URL=http://localhost:8000 HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/records.db CONCURRENCY_LEVELS=1,2,4,8,16,32,64 REQUESTS_PER_LEVEL=10 TEST_RUNS=3 QUESTIONS_PER_RUN=20 MAX_TOKENS=512 REQUEST_TIMEOUT_SECS=120 TZ_OFFSET_HOURS=8 SCHEDULED_HOUR=3 SCHEDULED_MINUTE=0 TZ=Asia/Shanghai
CMD ["/app/quanheng"]
DOCKEREOF

docker build -t quanheng-bench:test -f /tmp/Dockerfile.fast /tmp/
```

### 完整 Docker 构建（含交叉编译）

`Dockerfile` 支持 `linux/amd64` 和 `linux/arm64` 双架构：

```bash
# 纯本地架构构建
docker build -t quanheng-bench:test -f Dockerfile .
```

`build.sh` 脚本封装了完整的多平台构建流程：

```bash
# 默认构建 amd64 + arm64
./build.sh

# 指定版本号
./build.sh -v v1.0.0

# 输出到指定目录
./build.sh -o ./dist

# 只构建 amd64
./build.sh -p linux/amd64
```

Dockerfile 构建策略（**无需 QEMU/binfmt**）：

| 阶段 | 平台 | 说明 |
|---|---|---|
| `builder` | `$BUILDPLATFORM` | Rust 编译；`TARGETPLATFORM=linux/arm64` 时安装 `gcc-aarch64-linux-gnu` 并交叉编译到 `aarch64-unknown-linux-gnu`，产物 strip 后放 `/quanheng` |
| `runtime-files` | `$BUILDPLATFORM` | 准备 `ca-certificates` / `tzdata`（Debian 的 `Architecture: all` 包）与 `/etc/localtime`、`/etc/timezone` 到 `/rootfs` |
| 最终镜像 | `$TARGETPLATFORM` | 基于对应架构的 `debian:bookworm-slim`，**只做 COPY**（不做 apt-get），因此 arm64 构建不需要模拟器 |

> 为什么这样拆：运行阶段一旦执行 `RUN apt-get`，构建 arm64 就必须有 QEMU 用户态模拟（`binfmt_misc`），
> 很多 CI/容器环境没有权限注册。把与架构无关的证书/时区文件在构建平台准备好再复制，可以纯交叉编译出双架构镜像。

构建产物与命名：

| 命令 | 产物 |
|---|---|
| `./build.sh -v v0.3.0 -o ./dist` | `dist/quanheng-bench-v0.3.0-amd64.tar.gz`、`dist/quanheng-bench-v0.3.0-arm64.tar.gz` |
| `./build.sh -p linux/amd64` | 只构建当前架构 |

- 两个平台分别以 `quanheng-bench:<version>-<arch>` 打 tag，同一 Docker 主机可同时导入互不覆盖；
  脚本末尾的 `docker rmi` 是 best-effort（有容器占用时不会中断构建）。
- 镜像自检（导入后）：`/`、`/api/status`、`/assets/css/app.css`、`/assets/js/main.js`、
  `/assets/vendor/chart.js/chart.umd.min.js`、`/icons/*.svg` 全部 200，且 `/api/config` 的 `version` 与构建版本一致。
- arm64 镜像在 amd64 机器上无法直接 `docker run`（`exec format error`），可用
  `docker image inspect --format '{{.Architecture}}'` 或 `docker create` + `docker export` 校验二进制为 `ARM aarch64`。
- 双架构使用手册：`dist/使用手册.md`（随版本入库）。

### 本地部署（docker-compose）

```yaml
# docker-compose.yml — 开箱即用
services:
  quanheng-bench:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data          # 数据持久化
    environment:
      - BASE_URL=http://localhost:8000
      - CONCURRENCY_LEVELS=1,2,4,8,16,32,64
      - TEST_RUNS=3
    restart: unless-stopped
```

```bash
# 启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

### 容器运行示例

```bash
# 直接运行
docker run -d --name quanheng-bench \
  -p 3000:3000 \
  -v ./data:/app/data \
  -e BASE_URL=http://localhost:8000 \
  quanheng-bench:test

# 覆盖配置
docker run -d --name quanheng-bench \
  -p 3000:3000 \
  -e BASE_URL=https://your-api.example.com \
  -e API_KEY=sk-xxxx \
  -e CONCURRENCY_LEVELS=1,2,4,8 \
  -e TEST_RUNS=1 \
  quanheng-bench:test
```

> **注意：** 容器以 root 用户运行，确保宿主机挂载的 `./data` 目录有写权限（`chmod 777 ./data` 或保证权限开放）

---

## API 接口

服务**无鉴权**（无登录页、无 token），API 可直接 curl 调用；配套的 AI 说明见
`skills/quanheng-bench/SKILL.md`。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 仪表板页面 |
| `/history/:date` | GET | 历史数据页面 |
| `/api/dashboard?date=` | GET | 仪表板整页数据（模型、加权汇总、最佳值、状态、配置、运行日志） |
| `/api/status` | GET | 运行状态（含每模型进度、耗时、是否已请求取消） |
| `/api/models?refresh=1` | GET | 上游模型列表（缓存 60s，可强制刷新；上游故障时返回上次结果 + error） |
| `/api/trend?model=&metric=&concurrency=` | GET | 跨日期趋势序列 |
| `/api/run-log?limit=` | GET | 运行日志（倒序） |
| `/api/export.csv?date=&model=` | GET | CSV 导出（带 Content-Disposition） |
| `/api/run-test` | POST | 手动触发全量测试（运行中返回 409） |
| `/api/run-model` | POST | 只测一个模型 `{"model":"…"}`（运行中返回 409） |
| `/api/cancel` | POST | 取消当前运行 |
| `/api/today` | GET | 今日测试结果 (JSON，兼容保留) |
| `/api/history/:date` | GET | 指定日期结果 (JSON，兼容保留) |
| `/api/dates` | GET | 所有有数据的日期列表 |
| `/api/config` | GET | 当前配置信息 |

---

## 数据模型

```sql
test_records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  test_date       TEXT NOT NULL,         -- 测试日期 (YYYY-MM-DD)
  model           TEXT NOT NULL,         -- 模型 ID
  concurrency     INTEGER NOT NULL,      -- 并发级别
  request_count   INTEGER NOT NULL,      -- 成功请求数
  avg_ttft_ms     REAL NOT NULL,         -- 平均 TTFT (毫秒)
  min_ttft_ms     REAL NOT NULL,         -- 最小 TTFT
  max_ttft_ms     REAL NOT NULL,         -- 最大 TTFT
  p50_ttft_ms     REAL NOT NULL,         -- 中位数 TTFT
  p95_ttft_ms     REAL NOT NULL,         -- P95 TTFT
  p99_ttft_ms     REAL NOT NULL,         -- P99 TTFT
  avg_output_speed_tps REAL,             -- 首字后输出速度
  avg_tps         REAL NOT NULL,         -- 整体吞吐 (tok/s)
  total_tokens    INTEGER NOT NULL,      -- 总 token 数（成功请求的输出 token 合计）
  input_tokens    REAL NOT NULL DEFAULT 0,       -- 每请求平均输入 token（v2；v1 为 0）
  output_tokens   REAL NOT NULL DEFAULT 0,       -- 每请求平均输出 token（v2；v1 为 0）
  token_source    TEXT NOT NULL DEFAULT 'unknown', -- 'usage' 实测 / 'estimate' 估算 / 'unknown' v1
  protocol_version TEXT NOT NULL DEFAULT '1',    -- 测量协议版本（'1' 历史 / '2' 当前）
  cache_bust      INTEGER NOT NULL DEFAULT 0,    -- 前缀缓存是否已绕过
  success_rate    REAL NOT NULL,         -- 成功率 (%)
  total_duration_secs REAL NOT NULL,     -- 测试耗时
  created_at      TEXT NOT NULL,         -- 记录创建时间（UTC，SQLite datetime('now')）
  error_count     INTEGER NOT NULL DEFAULT 0,   -- 失败请求数
  error_summary   TEXT NOT NULL DEFAULT '',     -- 错误摘要 JSON：{"HTTP 429: …": 2}
  created_at_local TEXT NOT NULL DEFAULT ''      -- 配置时区的创建时间（界面显示用）
)

endpoint_capabilities (              -- protocol v2：端点能力缓存（避免每次运行重复探测）
  base_url              TEXT PRIMARY KEY,
  supports_stream_usage INTEGER NOT NULL,   -- 1 = 回 usage，0 = 4xx 拒绝未知字段
  probed_at             TEXT NOT NULL
)

run_log (
  id, started_at, finished_at, duration_secs,
  mode ('full' | 'model'), target, status ('running'|'success'|'failed'|'cancelled'),
  message, record_count
)
```

- 唯一约束：`(test_date, model, concurrency)`，重复测试自动覆盖（同一天多次运行只保留最后一次）。
- 迁移：`PRAGMA user_version` 控制（当前 v4），启动时自动补列 / 建表 / 回填 `created_at_local`；
  旧库首次启动会一次性清理重复行并保留 `MAX(id)`（最新那条）。
- **历史数据保护**：v4 之前的记录自动标记 `protocol_version='1'`、`token_source='unknown'`、`cache_bust=0`，
  保留原值不做改写——它们是 v1 口径（可能含前缀缓存命中），前端用 `v1` 徽标提示。
- 进程重启时，残留的 `run_log.status='running'` 会被标记为 `failed`（interrupted by restart）。

---

## 常见问题

### Q: 为什么升级到 v0.3.0 后 TTFT 变高了？

A: 这是**修正，不是回归**。0.2.0 及更早（protocol v1）没有处理前缀 KV 缓存：同一组题被所有并发级别、
所有轮次反复使用，在开启 APC/RadixAttention 的部署上绝大多数请求命中了缓存，测到的是"缓存服务"而不是冷用户。
v2 默认 `CACHE_BUST=1`（头部 nonce + 按级别换题）测冷 prefill，数字自然更高——那才是新用户真实感受到的首 token 延迟。

### Q: `token_source` 显示"估算"是什么意思？

A: 表示服务端没有返回 `usage`（或网关拒绝了 `stream_options`），token 数按字符估算：
CJK 1 字≈1 token，其他非空白字符 ~4 字符/token，偏差约 ±15%。
若显示"实测"则 token 数直接来自服务端 `usage`，TPS 精确。
`STREAM_INCLUDE_USAGE=auto` 会自动探测；查 `SELECT * FROM endpoint_capabilities` 看探测结果。

### Q: 历史数据还能和新数据一起看吗？

A: 能看，但**不要直接连线比较**。v1 记录（`protocol_version='1'`）是无缓存绕过、可能纯估算的口径；
界面用 `v1` / `实测` / `估算` / `协议 v2` 徽标标注每条记录的口径，趋势图也保留原始点。

### Q: `INPUT_TOKENS` 设了 1000，为什么实测输入 token 是 930？

A: 没有内置 tokenizer 时按 `token × 4` 字符构造，而估算时空白字符不计入，两侧口径不完全闭合，
偏差约 ±15%。精确等 token 需要 tokenizer 集成（P1 计划项）。

### Q: 为什么有些模型的输出速度显示很低？

A: 这反映了 API 的真实行为差异。逐 token 流式的模型（如 MiniMax-M2.7）输出速度是独立计算的。非真正流式的模型（首 token 后批量爆出）输出速度回退到整体 TPS，两者一致。

### Q: 为什么有些模型的 TTFT 比其他模型高很多？

A: thinking 模型的 `reasoning` 阶段会计入 TTFT。带深度思考的模型（DeepSeek-V4-Pro、Qwen3.6）首 token 延迟天然更高。代码已正确解析 `reasoning` 字段作为首 token 标记。

### Q: 每天定时测试是几点？

A: 默认每天 UTC+8 03:00。由 `SCHEDULED_HOUR` 和 `TZ_OFFSET_HOURS` 控制，程序内部自动将本地时间转换为 UTC cron 表达式。

### Q: 数据文件在哪？

A: 默认路径 `data/records.db`。通过 `DB_PATH` 环境变量可修改，建议挂载 volume 持久化。

### Q: 如何查看历史数据？

A: 在仪表板顶部日期选择器里选日期，或直接访问 `/history/2026-07-08`（同一套前端外壳）。

### Q: 为什么某个并发级别的请求数和「并发×2」对不上？

A: 实际请求数 = `max(band(并发), REQUESTS_PER_LEVEL)`：低并发 3×、中并发 2×、高并发 1×，
再与 `REQUESTS_PER_LEVEL`（默认 10）取较大值。这样 1 并发的 P99 不再是 3 个样本的猜测。
`/api/dashboard` 返回的 `config` 里有当前生效值。

### Q: 失败请求去哪了？以前只看得到成功率。

A: 现在每条记录带 `error_count` 与 `error_summary`（最多 5 类错误摘要），
前端「模型详情」表格里有「错误」列，运行记录里也会显示失败请求总数。

### Q: 怎么取消一次跑了很久的测试？

A: 页面「运行记录」里点「取消」，或 `curl -X POST http://host:3000/api/cancel`。
在途请求最多 250ms 内被中止，未完成的并发级别不会写库。

### Q: 前端需要 npm / 构建吗？

A: 不需要。全部是原生 ES Module + CSS 变量，改 `assets/js|css` 刷新即生效（运行时读取）；
只有改 `templates/` 才需要重新编译（模板在构建期被嵌入二进制）。
