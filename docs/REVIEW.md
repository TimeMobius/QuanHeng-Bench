# Health Checker 代码审查报告

> **审查基线**：`git rev-parse HEAD` = `180db58`。审查期间 Lead/frontend-dev 正在并行重构 `src/`、`templates/`，因此本报告所有源码与模板行号均取自 `git show HEAD:<path>` 的原始版本，不引用工作区中的重构版本；`dist/使用手册.md` 是未跟踪产物，按审查时磁盘内容引用。
> **方法**：逐文件静态阅读；用 HEAD 源码在 `/tmp/hc_head` 独立构建，并配假 OpenAI 上游做端到端复现（SSE 分块、坏模型名、CORS、超时、并发数）；只读复制 `data/records.db` 后用 `sqlite3`/`python3` 统计；用 Node 对浏览器解码后的 `onclick` 做执行验证；`cargo test` 验证现有测试。
> **结论摘要**：
> 1. 主流程可以跑通，但**统计链路不可信**：SSE 跨 chunk 半行会丢 usage/token；`REQUESTS_PER_LEVEL` 实际未生效；仪表板汇总只算第一张表；失败请求只计数、不落原因。
> 2. **安全面是 P0 级**：`CORS Any` + 无鉴权、模型名直接进入内联事件处理器（实测可弹 `alert`）、`POST /api/run-test` 无 CSRF 防护。
> 3. **可用性**：仪表板渲染同步请求 `/v1/models`，默认单次超时 1800s，上游故障时首页可挂起 30 分钟；长测试无法取消。
> 4. **数据层/文档**：每模型重开连接并重复跑 `init_db`、insert 连接没有 `busy_timeout`；`created_at` 用 UTC 而 `test_date` 用本地时区；AGENTS/使用手册与实际行为、镜像 tag 多处不一致。

## 总览

| # | 优先级 | 类别 | 结论 | 影响面 |
|---|---|---|---|---|
| P0-1 | P0 | 正确性/统计 | SSE 按 chunk 切行，跨 chunk 半行被丢弃，usage/token/TTFT 可能丢失 | 所有流式模型、token/TPS 报表 |
| P0-2 | P0 | 功能失效 | `REQUESTS_PER_LEVEL` 解析了但从未参与请求数计算，`/api/config` 仍回显它 | 压测强度不可配置、P99 样本过少 |
| P0-3 | P0 | 数据错误 | 仪表板汇总只读取第一张 `.table-card`，history 读取全部表格，口径不一致 | 多模型 KPI/平均值错误 |
| P0-4 | P0 | 安全 | 模型名含 `'` 时可逃逸内联 `onclick` 字符串，形成存储型 XSS | 所有访问者、上游模型列表可控时 |
| P0-5 | P0 | 安全 | `CorsLayer` 允许任意 Origin/Method/Header，且所有 API 无鉴权 | 数据泄露、跨站触发压测/DoS |
| P0-6 | P0 | 可用性 | `GET /` 在 handler 内同步 `fetch_models().await`，默认 1800s 超时 | 上游故障时整页挂起、并发堆积 |
| P0-7 | P0 | 数据一致性 | 每个模型 `Connection::open` + 重复 `init_db`；insert 连接无 `busy_timeout`；写失败被吞 | 并发写锁冲突、静默丢记录 |
| P1-1 | P1 | 数据模型 | 唯一索引 `(test_date, model, concurrency)` 覆盖当天多次运行；启动 `DELETE` 去重保留 `MIN(id)` 与注释相反 | 无运行级历史、旧库误删“最新” |
| P1-2 | P1 | 时区 | `created_at` 由 SQLite UTC 生成，`test_date`/`last_run` 用本地/U/混合时区 | 历史时间、上次运行时间显示错误 |
| P1-3 | P1 | 可观测性 | 失败请求只进分母，`RequestResult.error` 从未落库；流内 200 error 也被当成功 | 无法定位失败原因、成功率误报 |
| P1-4 | P1 | 交互/状态 | 进度只在整批 `join_all` 完成后累加，运行中进度长时间为 0 | 状态条失真、无法判断卡住 |
| P1-5 | P1 | 并发 | rusqlite 同步查询直接在 async handler 内执行，未 `spawn_blocking` | 阻塞 tokio worker、页面卡顿 |
| P1-6 | P1 | 功能 | 没有取消接口/取消标志；单请求最多 3 次 × 1800s 超时，7 级串行 | 长测试不可控、资源长期占用 |
| P1-7 | P1 | 统计口径 | `TEST_RUNS>1` 时 `request_count` 取均值、`total_tokens`/`duration` 求和、成功率取均值 | token/请求比虚高、汇总不一致 |
| P1-8 | P1 | 配置 | `TEMPLATES_DIR`/`templates_dir` 是死配置，模板用 `include_str!` 固化 | 部署方按文档改模板目录无效 |
| P1-9 | P1 | 构建/部署 | `/assets`、`/icons` 用编译期 `CARGO_MANIFEST_DIR` 绝对路径 | 独立二进制/快速镜像里图表和图标 404 |
| P1-10 | P1 | 压测设计 | 所有模型同时并行，无总并发上限（N 模型 × 64） | 上游被打爆、模型间互相干扰 |
| P1-11 | P1 | 精度 | 图表/汇总从已 `round(0)/round(1)` 的 `td.textContent` 反解析 | 平均值、P95/P99 精度损失 |
| P1-12 | P1 | 发布/文档 | `dist` 镜像 tag 与手册命令不符，镜像内容早于源码 | 按手册无法启动、功能缺失 |
| P1-13 | P1 | 协议健壮性 | SSE `data:` 无空格、`error` 事件、空响应未识别为失败 | 网关异常时成功率虚高 |
| P2-1 | P2 | 交互 | 完成后 `location.reload()`，丢失当前模型/视图，重拉一次模型列表 | 体验差、额外上游请求 |
| P2-2 | P2 | 稳定性 | 历史页持 DB lock 渲染、模板 `.unwrap()` panic；README 式问题 | 偶发 500、无法降级 |
| P2-3 | P2 | 状态 | `last_run` 只在内存，重启后丢失；`db::get_last_run` 实际未被页面使用 | “上次运行”消失 |
| P2-4 | P2 | 启动逻辑 | 当天有任意一条记录就跳过启动补测，崩溃留下的半套数据不会补全 | 日数据不完整 |
| P2-5 | P2 | API 语义 | `/api/run-test` 运行中仍返回 202，后台静默跳过 | 前端误以为已启动 |
| P2-6 | P2 | 图表 | “综合”图把 ms 和 t/s 画在同一 Y 轴；无深色模式/无空状态骨架 | 视觉误导 |
| P2-7 | P2 | 图标 | `icon_for` 子串匹配过宽（`ling`/`auto` 等） | 个别模型图标错误 |
| P2-8 | P2 | 容器 | root 运行、无 HEALTHCHECK、compose `version` 过时 | 运维/安全基线不足 |
| P2-9 | P2 | 重试 | 仅匹配部分 52x/554，429/超时策略与文档不一致 | 瞬时错误统计偏差 |
| P2-10 | P2 | 安全加固 | 无 CSP/X-Content-Type-Options/Referrer-Policy | 缺少纵深防御 |

## 详细发现

### P0-1 SSE 按 chunk 切行，跨 chunk 半行被丢弃
- 证据：`src/tester.rs:243-250`
  ```rust
  let chunk_str = String::from_utf8_lossy(&chunk);
  for line in chunk_str.lines() {
      ...
      if let Some(data) = line.strip_prefix("data: ") {
          if let Ok(chat_chunk) = serde_json::from_str::<ChatChunk>(data) {
  ```
  `src/tester.rs:276-278` 解析失败仅 `debug!` 后 `continue`；`src/tester.rs:305-308` 在拿不到 `usage.completion_tokens` 时用 `total_content.len()/4` 兜底。
- 现象/影响：一条 `data: {...}` 被 TCP 拆成两个 chunk 时，两个半行都不是合法 JSON；usage 丢失，token 退化为字符估算；若首 token 所在行被拆，TTFT 会被推迟到下一个完整行（或退化为总耗时）。用 HEAD 源码 + 假上游把同一条 event 分两次写出（间隔 300ms）复现：配置 `REQUESTS_PER_LEVEL=100`，实发 3 个请求、每个应 100 token，DB 记录 `total_tokens=3`（期望 300），日志出现 `Unparsable SSE line`。
- 根因：按 chunk 而不是按行缓冲；`String::from_utf8_lossy` 还会在 chunk 边界破坏多字节 UTF-8 字符（次要问题）。
- 建议修复：用 `Vec<u8>` 跨 chunk 累积，按 `\n` 切出完整行再 `from_utf8`/`from_utf8_lossy`；流结束时处理最后一行；为 `process_sse_line` 补“半行/多行/UTF-8 被拆”单测。S–M。
- 工作量：M（改动小，但需要 3 个边界测试 + 假上游集成测试）。

### P0-2 REQUESTS_PER_LEVEL 完全未生效
- 证据：`src/config.rs:67-70` 解析 `REQUESTS_PER_LEVEL` 并存入 `Config.requests_per_level`；但 `src/tester.rs:39-47` 的 `requests_for_level` 只按并发分档：
  ```rust
  if concurrency <= 4 { concurrency * 3 }
  else if concurrency <= 16 { concurrency * 2 }
  else { concurrency }
  ```
  `src/tester.rs:342`、`548`、`580` 都调用它；`src/routes.rs:193-205` 又把 `requests_per_level` 回显给 `/api/config`。
- 现象/影响：设置 `REQUESTS_PER_LEVEL=100` 后，并发 1 仍只发 3 个请求（假上游计数=3；DB `request_count=3`）。2026-08-27 的库内样本为 1→3、2→6、4→12、8→16、16→32、32→32、64→64（更早的 128 并发/30 条等历史行来自旧配置，不作为公式证据）；低并发 P99 只有 3 个样本，配置项形成“假旋钮”。
- 根因：实现只保留了旧 band 公式，没有把配置下限并入；测试也只断言 band 值。
- 建议修复：把 `requests_for_level` 改成 `band(concurrency).max(config.requests_per_level)`（0 表示仅 band），或把配置改名/删除；更新 `/api/config`、AGENTS、手册与单测。S。
- 工作量：S。

### P0-3 仪表板汇总只统计第一张表，且与 history 口径不一致
- 证据：`templates/dashboard.html:246-250`
  ```js
  const tbl=document.querySelector('.table-card');if(!tbl)return;
  const rows=tbl.querySelectorAll('tbody tr');
  ...
  document.getElementById('avgTtft').textContent=(t/c).toFixed(0)+' ms';
  ```
  第一张表是 `data.models[0]` 的模型表（`templates/dashboard.html:109-140`）；而 `templates/history.html:84-85` 用 `document.querySelectorAll('.card tbody tr')` 汇总全部模型。
- 现象/影响：多模型仪表板的“平均 TTFT/平均输出速度/平均吞吐/总请求/总 Token”只反映第一个模型；若第一个模型尚未测试，汇总显示 `-`，而其它模型已有数据。history 口径却是全部模型，两页同一指标数值不同。汇总还是按“行”未加权平均，且用的是已四舍五入的 `td.textContent`。
- 根因：服务端只渲染表格，前端为了画 KPI 又反解析 DOM；没有单一汇总源。
- 建议修复：在服务端（或新的 `/api/dashboard`）按记录集合计算一次加权 Summary（`request_count` 加权），前端直接渲染；若暂不重构，至少遍历全部 `.table-card tbody tr` 并与 history 共用函数。M。
- 工作量：M（服务端汇总 + 前端渲染）。

### P0-4 模型名进入内联 onclick 导致存储型 XSS
- 证据：`templates/dashboard.html:112-116`
  ```html
  <button class="view-tab active" onclick="switchView('{{ model|e }}','table')">…</button>
  ```
  同类 sink 还有 `id="mc-{{ model|e }}"`（110）、`data-model="{{ model|e }}"`（100、104）、`id="v-{{ model|e }}-table"`（118）。`|e` 只做 HTML 实体转义，而事件处理器属性在浏览器解析时会先把 `&#x27;` 解码回 `'`。
- 现象/影响：把 `/v1/models` 的 id 设成 `evil');alert(document.domain);//`，页面返回的 HTML 含 `onclick="switchView('evil&#x27;);alert(document.domain);&#x2f;&#x2f;','table')"`；去掉实体后实际执行的 JS 是 `switchView('evil');alert(document.domain);//','table')`。用 Node 按同样的“先 HTML 解码、再执行”流程验证，输出 `ALERT_FIRED: demo.example`。模型名来自上游，若上游/网关被污染，任何点开该模型 Tab 的访问者都会执行脚本；叠加 P0-5 的无鉴权，风险更高。
- 根因：服务端模板拼接 JS 字符串，且无 CSP；`|e` 不是 JS 字符串转义。
- 建议修复：删除全部内联事件，改用 `data-model` + `addEventListener`/事件委托；模型名只作为文本节点/属性值（由 DOM API 设置），不要拼进 JS；加严格 CSP（禁止 `unsafe-inline`）。S。
- 工作量：S（模板改动小，但需要回归测试/XSS 用例）。

### P0-5 CORS 任意来源 + 无鉴权
- 证据：`src/main.rs:146-151`
  ```rust
  CorsLayer::new()
      .allow_origin(tower_http::cors::Any)
      .allow_methods(tower_http::cors::Any)
      .allow_headers(tower_http::cors::Any)
  ```
  `src/routes.rs:32-52` 暴露所有页面/API；`POST /api/run-test`、`POST /api/run-model` 无任何 token/session 校验。
- 现象/影响：OPTIONS 预检带 `Origin: https://evil.example` 返回 `access-control-allow-origin: *`、`allow-methods: *`、`allow-headers: *`。任意网页可读 `/api/today`、`/api/history/*`、`/api/status`，并可跨站触发压测（`run-test` 还是无 body 的简单请求，不依赖 CORS 预检即可发出），造成数据泄露和上游/本机资源 DoS。
- 根因：默认配置过宽 + 服务本身没有认证边界；CORS 只限制浏览器“读响应”，不阻止“发请求”。
- 建议修复：默认不注册 CORS（同源），需要时用 `CORS_ORIGINS` 白名单；对外接口加 Bearer/Basic 或反向代理鉴权；对修改类接口要求自定义 header（触发预检）或 CSRF token；默认 `HOST=127.0.0.1` 更安全。M。
- 工作量：M。

### P0-6 仪表板被上游 `/v1/models` 阻塞
- 证据：`src/routes.rs:55-106`，其中 `72` 行在页面 handler 内直接：
  ```rust
  let available_models = match state.runner.fetch_models().await { ... }
  ```
  `fetch_models` 复用 `src/tester.rs:56-64` 的 client，超时取 `REQUEST_TIMEOUT_SECS`；`src/config.rs:87-90` 默认 `1800`。
- 现象/影响：假上游挂起不回包、`REQUEST_TIMEOUT_SECS=3` 时，`GET /` 实测耗时 `3.003s`；默认配置下最坏 1800s。期间每个访问者各占一个请求并长时间等待，响应无法返回，上游故障时首页打不开，也无法查看历史数据。
- 根因：页面渲染与外部依赖强耦合，没有缓存/超时/降级。
- 建议修复：把模型列表抓取移出渲染路径（页面只返回模板，或短超时 5–10s + 缓存/上次结果 + `models_error` 字段）；失败时仍渲染已测试模型；不要在 handler 里用 1800s 的超时。M。
- 工作量：M。

### P0-7 每模型重开 DB + insert 连接无 busy_timeout，写失败被吞
- 证据：`src/tester.rs:470-477`
  ```rust
  let db_conn = match Connection::open(&self.config.db_path) { ... };
  let _ = db::init_db(&self.config.db_path);
  ```
  `db::init_db` 在 `src/db.rs:7-12` 给**另一个**连接设 `PRAGMA busy_timeout=5000`，该连接随即被丢弃；insert 用的 `db_conn` 没有 busy_timeout。`src/db.rs:42-48` 每次 `init_db` 都跑一次 `DELETE ... GROUP BY`；`src/tester.rs:525-527`：
  ```rust
  if let Err(error) = db::insert_record(&db_conn, &record) {
      error!(... "Failed to insert test record");
  }
  records.push(record);
  ```
- 现象/影响：`run_full_test` 为每个模型并行建连、每个都执行 `init_db`（含 ALTER/DELETE/CREATE INDEX），全模型并发时会产生写锁竞争；insert 若遇 `SQLITE_BUSY` 无等待、直接失败，但记录仍被 push、运行仍报 `success` 和 “N records saved”，DB 实际缺数据。启动时 `DELETE` 还每次全表扫描。说明：`SQLITE_BUSY` 竞态未稳定复现（依赖时序），但“insert 连接没有 busy_timeout”与“错误被吞”是代码事实，可用两连接手工持锁验证。
- 根因：旧代码把“初始化”当成每次测试的前置动作；错误只记日志，不进入返回值/状态。
- 建议修复：启动时只 `init_db` 一次并共享连接（`Arc<Mutex<Connection>>` 或连接池）；所有 DB 操作放 `spawn_blocking`；insert 失败必须冒泡到运行结果/状态（`failed` 或 `partial`），并记录 `error_count`；`busy_timeout` 设置在共享连接上。M–L。
- 工作量：M–L（含迁移到共享连接与错误传播）。

### P1-1 唯一索引把“当天多次运行”压成一条，启动去重保留 MIN 与注释相反
- 证据：`src/db.rs:60-64` 唯一索引 `(test_date, model, concurrency)`，且 `CREATE UNIQUE INDEX ... .ok()` 会吞掉建索引失败；`src/db.rs:76-89` upsert 覆盖全部指标；`src/db.rs:42-48` 启动时：
  ```sql
  DELETE FROM test_records WHERE id NOT IN (
      SELECT MIN(id) FROM test_records GROUP BY test_date, model, concurrency
  );
  ```
  注释写“keep only the latest”，实际 `MIN(id)` 保留最早一条。
- 现象/影响：同一天对同一模型重测，旧结果被覆盖，`id` 不变（实测 2620→2620，仅 `created_at` 更新）；无法比较“今天 09:00 与 15:00”两次运行；旧库若有重复行，清理保留最旧值，与注释承诺相反。DB 现有 811 行，`(test_date, model, concurrency)` 唯一，2026-08-26 当天多次运行只剩一组记录。
- 根因：用“日报表”代替“运行记录”；去重 SQL 写反。
- 建议修复：新增 `run_log`/`run_id`（或把唯一索引改为 `(run_id, model, concurrency)`）并保留日报聚合视图；启动清理只在迁移时执行一次，且改 `MAX(id)`；在 AGENTS 明确“日报取最新一次”的语义。M。
- 工作量：M。

### P1-2 created_at UTC、test_date 本地、last_run 混用
- 证据：`src/db.rs:31` `created_at TEXT NOT NULL DEFAULT (datetime('now'))`（UTC）；`src/models.rs:141-147` `today_local` 用 `TZ_OFFSET_HOURS`；`src/tester.rs:522` 写入 `created_at = Utc::now()`；`src/routes.rs:275/283` 状态里的 `last_run` 也用 UTC；而 `src/tester.rs:551` 的 `test_date` 是本地日期。
- 现象/影响：DB 811 行中 484 行 `test_date != date(created_at)`，513 行 `created_at` 在 19:xx UTC（对应本地次日 03:xx 定时任务）；实测完成一个任务后 `/api/status.last_run` 为 `2026-11-20 17:10:37`，而本地（UTC+8）是 `2026-11-21 01:10`。历史页日期与“上次”时间不一致，跨午夜运行还会把结果记到前一天、页面“今天”却已翻页。
- 根因：没有统一“存储 UTC、展示本地”的边界；`last_run` 直接复用 UTC 格式化。
- 建议修复：DB 同时存 `created_at_utc` 和 `created_at_local`（或存 epoch），所有 API 输出 `*_local`；`today/test_date` 用一个注入的时区函数；跨午夜按运行开始时间归属并标注。S–M。
- 工作量：S–M。

### P1-3 失败请求只计数、原因丢失；200 流内 error 仍算成功
- 证据：`src/tester.rs:374-391` 只把 `result.success` 的结果放进 `successful_results`，失败仅影响 `total_count`；`RequestResult.error`（`src/models.rs:77`）没有被写入 DB；HEAD 的 `test_records` 没有 `error_count/error_summary`；`src/models.rs:35-40` 的 `ChatChunk.choices` 是必填，若上游返回 `data: {"error":...}` 则反序列化失败、仅 debug 日志，最终仍以空内容 `success=true` 收尾（`src/tester.rs:322-327`）。
- 现象/影响：假上游每隔一个请求返回 HTTP 500，3 个请求的结果是 `request_count=2, success_rate=66.67`，但 DB/API 看不到“哪个请求、为什么失败”；运行状态仍 `last_run_status=success`。用 HEAD 源码 + 200 流内 `data: {"error":...}` 复现：3 个请求全部被记为成功（`success_rate=100`），`total_tokens=3`（每请求被 `len/4.max(1)` 兜底成 1 token），错误信息只可能出现在 debug 日志里。
- 根因：数据模型只有成功样本；错误处理停留在日志。
- 建议修复：在聚合结果与 DB 增加 `error_count`、`error_summary`（最多 5 类），运行状态在 `error_count>0` 时至少 `partial`；SSE 解析支持 `{"error":...}` 并标记失败；UI 增加错误列。M。
- 工作量：M。

### P1-4 进度只在整批完成后更新
- 证据：`src/tester.rs:356-371` 先 `join_all(handles).await`，之后才在 `378-379` 对每个结果 `progress.completed.fetch_add(1)`；`src/routes.rs:176-190` 用 completed/total 计算进度。
- 现象/影响：实测并发 1、3 个请求，1.5s 时第一个请求早已完成，但 `/api/status` 仍是 `progress=0.0, completed_requests=0`；状态条在整级结束前不动，用户以为卡死。
- 根因：完成计数放在收集阶段，而不是请求完成回调。
- 建议修复：每个请求 `await` 返回后立即 `fetch_add`，或 worker 内完成时更新；`completed` 用 `min(total)` 防溢出。S。
- 工作量：S。

### P1-5 同步 rusqlite 查询阻塞 async runtime
- 证据：`src/routes.rs:58`、`113`、`156`、`165`、`171` 在 async handler 内 `state.db.lock().await` 后直接调用 `db::get_today_records/get_available_dates/...`；`src/tester.rs:470-527` 也在 async 任务内同步 insert。
- 现象/影响：DB 查询/写入在 tokio worker 线程执行，慢查询（历史页全表、启动 DELETE）会卡住同一 runtime 的其它请求；多个请求争抢 `Mutex<Connection>`。
- 根因：rusqlite 是同步 API，没有 `spawn_blocking` 包装。
- 建议修复：`tokio::task::spawn_blocking` 包裹所有 DB 调用，或使用 `deadpool-sqlite` 等异步封装；连接共享、写操作串行化。M。
- 工作量：M。

### P1-6 无法取消长测试
- 证据：`src/routes.rs:32-52` 只有 `GET/POST` 查询与触发路由，没有 cancel；`src/tester.rs:106-149` 每次请求最多 3 次尝试，`src/config.rs:87-90` 单次超时默认 1800s；`src/tester.rs:480-488` 7 个并发级别串行、每级 `test_runs` 轮。
- 现象/影响：上游挂起时一次全量测试可能持续数小时；页面没有“停止”按钮，只能重启进程；`Ctrl+C` 也会中断整个服务。
- 根因：没有运行级取消令牌/任务句柄。
- 建议修复：加 `Arc<AtomicBool>`/`CancellationToken`，worker 每轮/每 chunk 检查；新增 `POST /api/cancel`；状态返回 `cancel_requested`；UI 显示取消按钮；对 `send()`/stream 用 `tokio::select!` 响应取消。M。
- 工作量：M。

### P1-7 TEST_RUNS>1 时合并口径自相矛盾
- 证据：`src/tester.rs:500-523`（`merge_runs`）：
  ```rust
  request_count: (runs.iter().map(|r| r.request_count).sum::<usize>() as f64 / n) as usize,
  ...
  total_tokens: run_results.iter().map(|r| r.total_tokens).sum(),
  success_rate: ... / n,
  total_duration_secs: ... .sum(),
  ```
  即成功请求数取均值、token 与耗时求和、成功率取均值。
- 现象/影响：`TEST_RUNS=2` 时每个请求 100 token，DB 得到 `request_count=10`（两轮各 10 个成功，均值 10）但 `total_tokens=2000`（两轮求和），换算成“每请求 token”是实际的 2 倍；KPI/图表按 `request_count` 加权时也会错。docker-compose 默认 `TEST_RUNS=3`，问题在生产配置直接出现。
- 根因：没有定义清楚“日报记录”是单轮还是多轮聚合。
- 建议修复：统一为“多轮相加”：`request_count/error_count/total_tokens/total_duration` 求和，成功率 = 成功总数/尝试总数，TTFT 分位数按请求数加权；或每轮单独落库由前端聚合。S–M。
- 工作量：S–M。

### P1-8 TEMPLATES_DIR 是死配置
- 证据：`src/config.rs:56-58` 读取 `TEMPLATES_DIR`；`src/main.rs:48` 传给 `init_templates`；`src/routes.rs:291-304`：
  ```rust
  pub fn init_templates(_templates_dir: &std::path::Path) -> Environment<'static> {
      ...
      env.add_template_owned("dashboard.html", String::from(include_str!("../templates/dashboard.html")))
  ```
  参数以下划线开头、完全未使用；模板在编译期嵌入。
- 现象/影响：用户按环境变量改模板目录不会生效；Docker 内改 `/app/templates` 也无效；AGENTS 的 “修改 templates 后重启即可” 类描述会误导。
- 根因：单二进制部署选择了 `include_str!`，但保留了无效配置入口。
- 建议修复：删除 `TEMPLATES_DIR` 并在文档说明“模板编译期嵌入”；或改为运行时 `fs` loader 并保留嵌入作为 fallback。S。
- 工作量：S。

### P1-9 静态资源路径使用编译期绝对路径
- 证据：`src/routes.rs:43-50`
  ```rust
  .nest_service("/assets", ServeDir::new(concat!(env!("CARGO_MANIFEST_DIR"), "/assets")))
  .nest_service("/icons", ServeDir::new(concat!(env!("CARGO_MANIFEST_DIR"), "/icons")))
  ```
  官方 Dockerfile 在 builder/runtime 都用 `/app`，所以镜像里“碰巧”可用；`AGENTS.md:145-160` 的快速 Dockerfile 不复制 `assets/`、`icons/`，把宿主机编译的二进制放进镜像后这两个绝对路径不存在。
- 现象/影响：`docker build -f /tmp/Dockerfile.fast` 的镜像中 `/assets/vendor/chart.js/...` 与 `/icons/*` 全部 404，图表空白；把 `target/release/health-checker` 复制到其它机器运行也会 404。`dist/Dockerfile.arm64` 只 `COPY assets/`、没有 `icons/`，图标必 404。
- 根因：编译期路径被当成运行时路径；缺少“资源根目录”探测。
- 建议修复：运行时按 `ASSETS_DIR` → `./assets` → `/app/assets` → 可执行文件同级的 `assets` 顺序探测；icons 同理；Dockerfile.fast 和 `dist/Dockerfile.arm64` 补齐 `COPY assets/ icons/`；启动时找不到资源要 `warn`/fail-fast。S–M。
- 工作量：S。

### P1-10 全模型并行无总并发上限
- 证据：`src/tester.rs:559-599` `run_full_test` 为每个模型 `tokio::spawn`，`src/tester.rs:342-369` 每个模型再起 `concurrency` 个请求；`src/main.rs`/`config.rs` 没有全局并发配置。
- 现象/影响：14 个模型 × 并发 64 = 896 个在途请求同时打上游；模型之间互相抢带宽/队列，测得的 TTFT/吞吐不是单模型能力；上游可能限流/崩溃，进一步污染成功率。DB 里同时有 128 并发历史数据，旧配置更极端。
- 根因：把“每模型并发”误当成“系统总并发”。
- 建议修复：加全局 semaphore（如 `MAX_GLOBAL_CONCURRENCY`）或限制同时测试的模型数（如 `MAX_PARALLEL_MODELS=2–4`）；文档解释“总并发 = 模型数 × 级别”；压测结果标注并行模型数。M。
- 工作量：M。

### P1-11 图表/汇总从已四舍五入的 DOM 文本反解析
- 证据：`templates/dashboard.html:208-214`
  ```js
  return {c:parseInt(t[0].textContent), ttft:parseFloat(t[1].textContent), ...}
  ```
  表格输出在 `125-130` 已经 `round(0)`/`round(1)`；汇总在 `249` 再 `parseFloat(td[1].textContent)`。
- 现象/影响：P95=127.6 显示为 128，图表按 128 画；平均 TTFT 先逐项取整再平均，误差可累积；成功率显示也被取整。
- 根因：没有结构化数据源，DOM 既是展示层又是数据层。
- 建议修复：模板内嵌 JSON（`<script type="application/json">`）或新增 `/api/today`/`/api/history` 前端 fetch，图表直接用原始数值；服务端算好汇总。M。
- 工作量：M。

### P1-12 dist 镜像与使用手册、源码三者漂移
- 证据：`dist/health-checker-v0.1.0-amd64.tar.gz` 的 `manifest.json` 中 `RepoTags` 为 `["health-checker:v0.1.0"]`；`dist/使用手册.md:9-10` 却写 `health-checker-latest-amd64.tar.gz`，`:38/:51/:64` 运行 `health-checker:latest-amd64`；镜像内二进制 strings 只有 `/api/dates /api/status /api/run-test /api/run-model /api/config`，没有新源码的 `/api/dashboard`、`/api/cancel`、`/api/run-log`、`/api/trend`。
- 现象/影响：按手册 `docker load` 后镜像 tag 是 `health-checker:v0.1.0`，执行 `docker run health-checker:latest-amd64` 会 `Unable to find image`；即使改 tag，镜像也是旧版，缺少当前前端/取消/运行日志等功能。
- 根因：发布物未随源码重建；手册按 build.sh 的 `latest` 默认值写死，但 dist 用 `-v v0.1.0` 构建。
- 建议修复：用当前源码重建 dist 并核对 `RepoTags`；手册改用 `health-checker:v0.1.0`（或显式 `docker tag` 成 `latest`）；CI 中校验 `strings`/API smoke 与手册版本一致。S。
- 工作量：S。

### P1-13 SSE 协议边界处理不完整
- 证据：`src/tester.rs:249` 只接受 `"data: "`（带空格）；`src/tester.rs:246` 只跳过 `"data: [DONE]"`；`process_sse_line` 无 `error` 字段；`src/models.rs:35-40` `ChatChunk.choices` 无 `#[serde(default)]`。
- 现象/影响：部分网关发送 `data:{...}`（无空格）或 `data: [DONE]` 大小写/前后空白不一致时，行被当成 JSON 解析失败而丢弃；`data: {"error":...}` 或 `choices: null` 解析失败，最终空内容仍按成功计；SSE 注释/`event:` 行会被当作数据行解析失败。
- 根因：只覆盖了 OpenAI 标准格式，没有兼容层。
- 建议修复：`strip_prefix("data:")` 后再 `trim_start()`；显式解析 `error` 字段并标记失败；`choices` 加 `#[serde(default)]`；跳过非 `data:` 行；为每种格式加单测。S。
- 工作量：S。

### P2-1 完成后整页 reload
- 证据：`templates/dashboard.html:267` `if(s.last_run_status==='success'){...setTimeout(()=>location.reload(),1500);}`。
- 影响：丢失当前模型 Tab/图表视图/滚动位置；重新执行 `fetch_models`（P0-6 的成本）；完成提示后页面闪白。
- 修复：只重新拉取 `/api/status` + 当前数据（或轮询 `/api/today`），局部重渲染；保留 URL/hash 状态。S。

### P2-2 历史页持锁渲染与模板 unwrap
- 证据：`src/routes.rs:113` 获取 `db` guard 后一直持有到 `149` 渲染完；`97/103/141/147` 对 `get_template`/`render` 用 `.unwrap()`。
- 影响：模板渲染期间阻塞其它 DB 请求；模板语法/变量错误导致 handler panic，客户端得到连接重置而非 500；无降级。
- 修复：查询完尽快 drop guard；`match` 返回 500 并记录；模板启动时做一次渲染 smoke test。S。

### P2-3 重启丢失“上次运行”
- 证据：`src/routes.rs:49-64` `test_status` 初始化为 `last_run: None`；`src/db.rs:167-176` 有 `get_last_run`，但 `src/routes.rs:57-63` 只读出来塞进 `DashboardData.last_run`，模板从未使用；页面只从 `/api/status` 取。
- 影响：重启后“上次”为空，即使 DB 有数据；用户无法确认最近一次成功时间。
- 修复：启动时从 DB 初始化 `test_status.last_run`；或页面直接显示 `run_log` 最新一条；统一本地时区。S。

### P2-4 启动补测以“任意记录”判断
- 证据：`src/main.rs:78-84` 用 `get_today_records().is_empty()` 判断是否启动测试。
- 影响：若昨天的定时任务/手动任务中途崩溃，只写入部分模型，重启后当天视图非空，不会补测，日数据长期不完整；也无法从状态看出缺了哪些模型。
- 修复：用“今日计划模型数 vs 已覆盖模型/并发级别”判断完整性，或依赖 run_log 的 success 状态；提供手动补测入口。S–M。

### P2-5 运行中触发仍返回 202
- 证据：`src/routes.rs:208-218` 无条件 `tokio::spawn` 后返回 202；真正的 guard 在 `src/routes.rs:242-248`，重复触发只记 `info` 后 return。
- 影响：前端收到 202 会进入“测试中”并开始轮询，实际并未启动新测试；两个标签页会看到混淆的状态。
- 修复：在 handler 内先检查运行状态并返回 409/`{"error":"test already running"}`；或把 guard 移到 `run_test_background` 前。S。

### P2-6 图表“综合”混轴、无深色模式/骨架
- 证据：`templates/dashboard.html:236-241` 把 `TTFT(ms)`、`输出速度(t/s)`、`吞吐(t/s)` 放进同一 Y 轴柱状图；`:118-144` 视图容器初始 `display:none`，首次切换图表才创建；无 `prefers-color-scheme`。
- 影响：ms 与 t/s 量级不可比，视觉上 TTFT 柱几乎不可见；深色系统下白底刺眼；加载时只有空白表格。
- 修复：拆双轴或分图；CSS 变量 + 深色主题；骨架屏/空状态；图表容器 `role=img` + `aria-label`。S–M。

### P2-7 图标匹配过宽
- 证据：`src/icons.rs:130` `lower.contains("ling") || lower.contains("ring")`；`:140` `contains("rikka") || contains("auto")`；`:108` `contains("302")`。
- 影响：`sampling-model` 会命中 `ling.png`，`automatic` 会命中 `rikkahub.svg`，`model-302b` 会命中 `302ai.svg`；厂商图标错误但不影响功能。
- 修复：对短关键词使用词边界/前缀匹配，或维护“厂商前缀”映射表；补反例测试。S。

### P2-8 容器安全/运维基线
- 证据：`Dockerfile:49-83` 运行 root、无 `HEALTHCHECK`、无 `--read-only`/非 root 用户；`docker-compose.yml:1` `version: "3.8"` 已过时；compose 默认 `TEST_RUNS=3`（`:17`）而 Dockerfile/AGENTS 默认 1。
- 影响：容器逃逸面较大；编排端无法感知“进程活着但 DB/上游不可用”；compose 与文档默认值不一致，压测强度悄悄 ×3。
- 修复：创建 `app` 用户 + `USER app`；加 `/healthz` 或 `HEALTHCHECK`；删除 `version`；统一 `TEST_RUNS` 默认值并在文档标注。S。

### P2-9 重试分类不完整
- 证据：`src/tester.rs:126-134` 只匹配 `HTTP 52x/554` 与特定字符串；`429`、`HTTP 500`、`HTTP 503` 的 `error` 字符串以 `HTTP 500:` 开头，无法命中 `starts_with("HTTP 52")`；`REQUEST_TIMEOUT_SECS` 超时的 `timed out` 也不在列表。
- 影响：网关限流/5xx 被记为硬失败，成功率偏低；重试语义与文档“瞬时失败重试”不一致（旧文档未明确，但代码注释称 transient）。
- 修复：按状态码数值分类（`status.is_server_error()`/429/408），或解析 `reqwest::Error` 的 timeout 分类；重试次数/退避可配置。S。

### P2-10 安全响应头缺失
- 证据：`src/main.rs:142-152` 只有 `TraceLayer` + CORS，没有 CSP、`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`；模板内联 `<style>`/`<script>` 进一步限制 CSP 可行性。
- 影响：XSS 一旦出现缺少浏览器侧缓解；点击劫持/信息泄露风险。
- 修复：外置 CSS/JS 后加严格 CSP；至少加 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`。S。

## 前端评估

**可维护性**：HEAD 的 `dashboard.html` 274 行中包含约 60 行内联 CSS、约 100 行内联 JS 和业务表格；`history.html` 又完整复制一套 CSS/表格样式，两个页面没有共享 base/partials。CSS 选择器与业务类名混用（`.table-card` 同时是布局和汇总锚点），`switchView` 用中文 Tab 文本反查视图名（`map[at.textContent.trim()]`），改文案会破功能。事件处理器全部内联；没有模块边界、没有构建、没有类型检查，单文件部署友好但修改风险高。
**数据流**：服务端 minijinja 拼出模型 Tab、表格和汇总卡 → 浏览器 JS 再解析 `td.textContent` 画 Chart.js、算 KPI；服务端不提供 JSON 汇总。结果是展示精度（round）反向污染数据（P1-11），且 dashboard 只算第一张表、history 算全部（P0-3），同一指标两页不一致。状态流是 `fetch /api/status` 每 2s 轮询 + 完成后 `location.reload()`，没有局部更新/取消/错误详情。
**交互**：运行测试/单模型重测有 loading/disabled；但无取消、无失败原因、无每模型进度；测试完成整页刷新丢失视图；模型 Tab 用 `role="button" tabindex="0"` 却没有 Enter/Space 处理；日期历史只在 dashboard 侧栏，history 页没有日期选择器（只有已有日期按钮）；空状态只在 `data.models` 为空时出现，而不是“今日无数据”。
**可访问性**：`role=button` 无键盘激活；表格无 `scope`/caption；canvas 无 `role="img"`/`aria-label`；状态用 emoji+颜色双编码但无文本说明；toast 无 `aria-live`；无 `:focus-visible` 自定义样式；无 `prefers-reduced-motion`；移动端表格仅横向滚动，图表在隐藏容器中首次绘制有 100ms `setTimeout` 竞态。
**视觉**：配色（#5b6abf + 卡片阴影）统一、层级清楚，表格密度适合桌面；但“综合”图混轴（P2-6）、无深色模式、无 loading 骨架、成功率仅用颜色/emoji 表达，窄屏 header 会换行拥挤。
**前端重构建议**：值得拆成 `base.html + partials + dashboard/history` 和原生 ES Module（`api/store/format/charts/views`），但**不建议引入 React/Vue 构建链**：项目是单二进制、模板编译期嵌入、静态资源由同一个 Rust 服务提供，构建链会增加产物同步/版本漂移成本，收益主要是组件复用，而当前页面数量少。推荐路径：先抽 `base.html` 和 `assets/css/app.css`；再把“表格/图表/汇总”统一改为消费 `/api/today`、`/api/history/:date` 或新的 `/api/dashboard` JSON；图表用 Chart.js 本地 vendor；用 `data-*` + 事件委托替代内联 `onclick`；主题用 CSS 变量 + `prefers-color-scheme`；a11y 采用 `role=tablist/tab/tabpanel` + 方向键。无构建方案可以保留，前提是模板/模块数量可控；若未来要“多模型对比/趋势/运行记录”多视图，再评估轻量 Preact/lit，仍可保持无 bundler（用原生 ESM + 预编译）。验收：无 console error、XSS 用例通过、dashboard/history 同一汇总一致、移动端 375px 无横向溢出、键盘可完成“切模型/切图/选日期/取消运行”。

## 文档与代码漂移

以下按 HEAD 的 `AGENTS.md` 与审查时磁盘上的 `dist/使用手册.md` 对照（重构中的新 AGENTS 已修正部分条目，本表保留原始差异用于验收）：

| 文档位置 | 文档说法 | 代码/实际 | 影响 |
|---|---|---|---|
| `AGENTS.md:11,130` | 内置 500 题、12 个领域 | `src/questions.rs` 实际 510 个字符串、13 个分节注释 | 题库数量/覆盖面描述错误 |
| `AGENTS.md:14` | 每个并发级别跑 3 轮取平均 | `config.rs:72-75` 默认 `TEST_RUNS=1`；compose 覆盖为 3 | 读者以为默认 3 轮 |
| `AGENTS.md:15` | 每轮请求数 = `max(并发×2,10)` | `tester.rs:39-47` 是 3×/2×/1×，且 `REQUESTS_PER_LEVEL` 完全未用 | 压测规模预期错误 |
| `AGENTS.md:27` | Minijinja 1.x | `Cargo.lock` minijinja 2.21 | 版本/特性描述过期 |
| `AGENTS.md:31` | Chart.js 4.x CDN 加载 | `templates/dashboard.html:7` 用本地 `/assets/vendor/chart.js/...` | 离线部署预期错误 |
| `AGENTS.md:52` | DB_PATH 默认 `/app/data/records.db` | `config.rs:47-49` 默认 `data/records.db`（仅 Docker ENV 覆盖） | 本地运行路径不一致 |
| `AGENTS.md:54` | REQUESTS_PER_LEVEL 每级最小请求数 | 实际未生效（P0-2） | 配置无效 |
| `AGENTS.md:253-262` | API 表只有 `/api/run-test` | `routes.rs:40-41` 还有 `/api/run-model`（且无 dashboard/cancel 等） | 接口文档缺项 |
| `AGENTS.md:145-160` | Dockerfile.fast 只 COPY 二进制 | 未复制 `assets/`、`icons/`，HEAD 的 `ServeDir` 用编译期绝对路径 | 快速镜像图表/图标 404 |
| `AGENTS.md:290` | 唯一约束重复测试自动覆盖 | 覆盖会丢失当天运行级历史（P1-1） | 语义不完整 |
| `使用手册:9-10,18-19` | 文件名为 `health-checker-latest-*.tar.gz` | `dist/` 实际是 `health-checker-v0.1.0-*.tar.gz` | 按手册解压失败 |
| `使用手册:38,51,64,111,134` | 运行 `health-checker:latest-amd64` | 镜像 `RepoTags` 是 `health-checker:v0.1.0` | `docker run` 找不到镜像 |
| `使用手册:107` | `BASE_URL=https://api.openai.com/v1` | `tester.rs:69` 拼 `{base_url}/v1/models` → `/v1/v1/models` | 照抄示例必 404 |
| `使用手册:75` | ARM64 “原生编译无障碍” | Dockerfile 实际用 `gcc-aarch64-linux-gnu` 交叉编译 | 描述不准确 |
| `使用手册` 环境变量表 | 未列 `TEMPLATES_DIR` 等 | `TEMPLATES_DIR` 存在但无效（P1-8） | 用户误配 |
| `dist/Dockerfile.arm64:5-6` | 只复制二进制+assets | 没有 `icons/` | 图标 404 |
| `dist/*.tar.gz` | 手册暗示是当前版本 | 镜像内 endpoint 只有旧 API，无 `/api/dashboard`/`/api/cancel` | 发布物与源码不一致 |

## 测试与可观测性

**现有测试**：HEAD `cargo test` 11 个用例全部通过，覆盖：
- `icons` 5 个（映射/优先级/大小写/fallback）；
- `questions` 4 个（题库非空/随机抽取/超量）；
- `tester` 2 个（请求数 band、进度 reset）。
没有覆盖：`db.rs` 的建表/迁移/upsert/去重、`routes.rs` 的 HTTP 状态码与模板、`config.rs` 的解析/时区/cron、SSE 解析、请求重试、并发/取消、汇总算法、CSV、前端 JS/HTML 转义。没有集成测试、没有对 `/v1/models`/`/v1/chat/completions` 的假上游测试、没有前端 E2E/截图测试。

**建议补充**（按性价比排序）：
1. SSE 单测：一条 JSON 在任意字节位置被切成 2/3 段；`data:` 无空格；`[DONE]`；`error` 事件；UTF-8 多字节被拆；断言 usage/token/TTFT 与完整流一致。
2. `requests_for_level` + `merge_runs`：`REQUESTS_PER_LEVEL=0/1/10/100`；`TEST_RUNS=1/2/3`；断言成功数/错误数/token/耗时口径一致。
3. DB：临时库迁移旧 schema（无 `avg_output_speed_tps`、有重复行）→ 检查列/唯一索引/保留 MAX(id)；并发 insert（多线程）验证 busy_timeout；upsert 两次断言一行。
4. Routes：`/api/status`（running/完成/失败）、`/api/run-test` 重复触发 409、`/api/run-model` 空模型 400、非法日期 400、CSV 转义、模板渲染 200。
5. 模板 XSS：模型 id 含 `'`、`"`、`/`、`<script>`，断言无内联 handler/属性不被截断（或直接断言输出 JSON API）。
6. 时区：`TZ_OFFSET_HOURS=8/-5` + 跨午夜时间注入，断言 `test_date`、`created_at_local`、`last_run` 一致。
7. 前端：用 Playwright/轻量 DOM 断言 dashboard 汇总等于服务端加权值、切模型/图表不报错、移动端 375px 无溢出；至少做 `node --check` 与模板 JSON 快照。
8. 发布：CI 构建镜像后 `curl /api/dashboard`、`/assets/vendor/chart.js/...`、`/icons/...` 200；`strings` 校验 endpoint；`docker run` 手册命令 smoke。

**可观测性现状**：JSON 结构化日志（`tracing`）能记录 HTTP 错误/重试/模型级完成，但：
- 没有 request id/run id 串起一次运行；`run_log`（HEAD 没有）缺失；
- 失败只 warn 日志，DB/状态无错误原因（P1-3）；
- 进度只在整批更新（P1-4），状态条不可信；
- `last_run` 内存态，重启丢失（P2-3）；
- 无 `/healthz`、无 DB 迁移版本日志、无队列/在途请求指标；
- 前端 `catch(e){}` 静默吞轮询错误（`dashboard.html:268`），用户看不到网络故障。
建议先补 run_log + error_count/error_summary + `/healthz`，再考虑 Prometheus 指标。

## 建议路线图

**批次 1（P0，2–3 天）数据正确性与安全**
- SSE 行缓冲/UTF-8 边界；`REQUESTS_PER_LEVEL` 生效或删除；失败原因落库（error_count/error_summary）；汇总改为服务端加权 JSON。
- 移除所有内联 `onclick`，模型名仅作文本/`data-*`；CORS 默认同源 + 可选白名单；修改类 API 加 CSRF header 或鉴权；模型列表短超时 + 缓存/降级。
- DB 改共享连接 + `spawn_blocking` + `busy_timeout`；insert 失败冒泡；启动清理改 `MAX(id)`。
- 验收：分块 SSE 假上游 token 完全一致；含 `'`/`"`/`/` 的模型名页面无脚本执行；evil Origin 预检无 ACAO；上游挂起时 `GET /` <500ms 且可看历史；`REQUESTS_PER_LEVEL=100` 实发 100；`cargo test` + 新增测试全绿。

**批次 2（P1，2 天）统计与运行体验**
- `TEST_RUNS` 合并口径统一；`last_run` 本地时区并从 DB 恢复；进度按请求实时更新；取消 API + UI + worker 取消检查；`MAX_PARALLEL_MODELS`/全局并发上限。
- 验收：`TEST_RUNS=2` 的 token/请求比与单轮一致；运行中 1s 内进度增长；点击取消 1s 内进入 cancelled 且无半套 DB 记录；N 模型总并发不超过配置。

**批次 3（P1，1 天）部署与文档**
- assets/icons 运行时探测；Dockerfile.fast/`dist/Dockerfile.arm64` 补 `assets/ icons/`；重建 dist 并统一手册 tag/文件名；删除 `TEMPLATES_DIR` 或实现 loader；AGENTS 与手册按实际公式/版本/接口重写。
- 验收：按手册 `docker load` + `docker run` 一次成功；镜像内 `/assets`/`/icons` 200；`/api/config`、AGENTS、手册三处一致；`git grep` 无过期的 500 题/3 轮/CDN/Minijinja 1.x 描述。

**批次 4（P2，2–3 天）前端与可维护性**
- 抽 `base.html`/partials/ES Module；用 JSON 数据源替代 DOM 反解析；图表双轴/深色模式/空状态；去掉 reload；a11y（tablist/aria/scope/role=img）；统一 dashboard/history 汇总。
- 验收：两页同一汇总数值一致；无 `console.error`；键盘可完成主要流程；375px 无溢出；Lighthouse a11y ≥90；模型 XSS 用例回归通过。

**暂不建议做**：引入 React/Vue/打包器。当前页面数量和单二进制约束下，原生 ESM + 服务端模板的收益/成本比更好；先完成数据契约和模块拆分，再评估框架。

---

## 附录 A：本轮迭代修复状态（Lead 补充，2026-11-21）

> 说明：本附录由 Lead 在审查报告完成后补充，记录**本工作区**（重构后代码）对上述发现的实际处理情况，
> 便于分辨「已修 / 部分修 / 未做」。审查报告正文仍以 `HEAD=180db58` 为基线。

### 已修复

| 编号 | 修复方式 | 验证 |
|---|---|---|
| P0-1 | `SseLineBuffer` 按**字节**缓冲、按 `\n` 切行，跨 chunk 半行与跨 chunk 的 UTF-8 多字节字符都不再丢；末尾无换行的残留行也会 flush | 单测 3 条（半行拼接/多字节/无换行残留）；mock 上游把一条 `data:` 行拆成两次写入，`total_tokens` 从 3 恢复为与 usage 一致的 1536 |
| P0-2 | `REQUESTS_PER_LEVEL` 成为每级请求数**下限**：`max(band(并发), REQUESTS_PER_LEVEL)`，`0` 表示只用 band | 单测覆盖 0/10 两档；`/api/config` 回显真实生效值；`/api/dashboard.config` 同步 |
| P0-3 | 新增 `/api/dashboard`，汇总在服务端按请求数加权计算；dashboard 与 history 复用同一份 `Summary` | 单测 3 条（加权/全失败/空集合）；页面 KPI 与接口数值一致 |
| P0-4 | 删除全部内联 `onclick`/字符串拼 id；改用 `data-*` + 事件委托 + `textContent` 渲染模型名 | 恶意模型名 `<img src=x onerror=alert(1)>`、`a'b"c/d` 渲染为转义文本，DOM 中无 `<img>`、无 `onerror` 属性（CDP 实测） |
| P0-5 | CORS 改为 opt-in（`CORS_ORIGINS`，默认同源、不再 `allow_origin(Any)`）；另加 `nosniff`/`no-referrer`/`X-Frame-Options` | 默认启动无 CORS 头；鉴权仍未内置（建议由反代承担，见附录 B） |
| P0-6 | 页面只渲染外壳，数据由浏览器拉 `/api/dashboard`；模型列表 60s 缓存（`MODELS_CACHE_SECS`）+ 10s 超时 + 失败回落上次结果 | 上游挂起时 `GET /` 仍 <100ms；`/api/models` 返回 stale + `error` |
| P0-7 | 单一共享连接（`Arc<Mutex<Connection>>`）+ 全部访问走 `spawn_blocking`；`busy_timeout` 设在该连接上；insert 失败写日志并计入运行消息；删除每模型 `init_db` | DB 单测 3 条；mock 并发 3 模型 × 2 级写入无 `database is locked` |
| P1-2 | 新增 `created_at_local`（配置时区）并迁移回填；`/api/*` 同时返回 `created_at`(UTC) 与 `created_at_local` | 旧库 811 行回填后无空值；页面只显示本地时间 |
| P1-3 | `error_count` / `error_summary` 落库；SSE `error` 帧与空流识别为失败；错误摘要最多 5 类 | mock 503 → `error_count=6/12`、`success_rate=0`、`error_summary` 聚合正确；单测覆盖 error 帧 |
| P1-4 | 进度改为每完成一个请求即累加，并新增每模型 `{total,completed,status}` | 运行中 `/api/status` 文案为 `Testing... 39/54 requests`，模型级状态 `pending/running/done/error` |
| P1-5 | 所有 SQLite 调用 `spawn_blocking`，不阻塞 tokio worker | 10 并发 `/api/dashboard` 合计 60ms 返回 |
| P1-6 | `POST /api/cancel` + `AtomicBool` + 250ms 轮询；未完成的并发级别不落库；`Cancel` 在模型列表抓取阶段也生效 | 慢流实测取消后 250ms 内 `cancelled`、0 条记录；抓取阶段取消同样 0 条 |
| P1-7 | `merge_runs` 改为**总量口径**：`request_count`/`error_count`/`total_tokens`/`duration` 求和，延迟按成功请求数加权，`success_rate = req/(req+err)` | 单测断言 `TEST_RUNS=2` 时 `request_count` 翻倍且成功率与计数自洽；e2e `TEST_RUNS=2` 得到 6/12 条请求 |
| P1-8 | 删除死配置 `TEMPLATES_DIR`；`build.rs` 自动扫描 `templates/` 并全部嵌入（含 partials） | 模板无需手工登记；改模板后重编译即生效 |
| P1-9 | 资产目录运行时探测（`ASSETS_DIR` → `./assets` → `/app/assets` → 源码树）；Dockerfile/.dockerignore/手册同步 | `/assets/css/app.css`、`/assets/js/main.js`、`/icons/...` 均 200 |
| P1-10 | 新增 `MAX_PARALLEL_MODELS`（默认 8，上限 32）限制同时在测模型数 | e2e `MAX_PARALLEL_MODELS=1` 时模型串行 |
| P1-11 | 图表与 KPI 全部消费 JSON（不再解析 `td.textContent`），精度不再被 round 污染 | CDP 抓取 canvas 数量与图表配置核对 |
| P1-13 | `data:` 无空格、`[DONE]`、`error` 帧、空流均已处理 | 单测覆盖 error 帧与多字节分块 |
| P2-1 | 完成后只重拉 `/api/dashboard` 局部重渲染，保留视图/模型/滚动位置 | 运行完成无整页刷新 |
| P2-2 | 历史/仪表板渲染不再持锁、不再 `unwrap()` 模板 | 非法日期 400；模板缺失返回 500 JSON 而非 panic |
| P2-3 | `run_log` 持久化每次运行；空闲态状态条回落到最近一条运行记录 | 重启后页面仍显示「上次运行 … · 成功/失败/已取消」 |
| P2-5 | 运行中触发返回 `409 {"error":"test already running"}` | 并发 3 次 POST 实测 `202/409/409` |
| P2-6 | 双 Y 轴图表、深色模式（跟随系统 + 手动）、加载骨架、空/错状态 | 深浅色截图各视图核对 |
| P2-9 | 重试按 429/5xx/超时/流错误分类，3 次退避重试 | 单测 5 条分类断言 |
| P2-10 | 增加 `nosniff` / `no-referrer` / `X-Frame-Options: DENY` | `curl -I` 验证响应头（CSP 暂缓：主题引导脚本为内联） |

### 部分修复 / 未做（明确保留）

| 编号 | 状态 | 说明 |
|---|---|---|
| P0-5 | 部分 | 无内置鉴权。若实例暴露公网，请在反代加 Basic Auth / OIDC，或限制内网访问 |
| P1-1 | 部分 | 去重改为保留 `MAX(id)`；但仍按 `(日期,模型,并发)` 唯一，**当天多次运行只保留最后一次**（运行级历史改由 `run_log` 承担）。若需要每次运行快照，需另加 `run_id` 维度 |
| P1-12 | 已修复 | 文档（AGENTS/使用手册）与本轮实现一致；`dist/` 已重建 **v0.2.0 双架构镜像**（amd64 + arm64，QEMU-free 构建），旧产物移入 `dist/archive-v0.1.0/`；`build.sh` 改为按平台打 tag、清理步骤 best-effort |
| P2-4 | 未做 | 启动补测仍以「当天是否有任意记录」判断；更稳的做法是按 `CONCURRENCY_LEVELS × 模型数` 校验完整性 |
| P2-7 | 未做 | `icon_for` 子串匹配仍偏宽（`ling`/`auto` 等），属低优先级 |
| P2-8 | 部分 | 移除了 compose 过时的 `version`；容器仍以 root 运行、未加 `HEALTHCHECK` |

### 新增测试

`cargo test`：11 → 29 条，新增覆盖 SSE 行缓冲（半行/多字节/残留）、错误帧识别、`reasoning_content` 首 token、
请求数策略（band + floor）、运行合并口径、加权汇总（含全失败/空集合）、健康度阈值、严格日期校验、
CSV 转义与下载文件名、DB 迁移/upsert/错误摘要/趋势/运行日志/stale 清理。
`cargo clippy --all-targets -- -D warnings` 全绿。
