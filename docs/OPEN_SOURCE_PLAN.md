# 方向决策：并入 QueQiao-Router，还是独立开源？

> 决策日期：2026-11-21 · 相关文档：[MERGE_INTO_QUEQIAO.md](MERGE_INTO_QUEQIAO.md)、[REVIEW.md](REVIEW.md)
> 结论先行：**不建议把代码库合并进 QueQiao-Router；建议把本项目独立命名、按开源产品打磨，同时提供一等公民的 QueQiao 集成。**

## 0. 定位（用户已确认）：不同内网、不同配置部署模型的"度量衡"

> 用户原话（2026-11-21）："我想让这个项目作为在不同内网环境用不同配置部署模型的度量衡。"
> 定位不是"一次性压测工具"，而是**标准本身**：如秦统一度量衡（书同文、车同轨、同度量），
> 为不同内网 / 硬件 / serving 栈 / 部署配置上的模型性能提供同一口径，让数字**可互比**。
> 工具的核心价值不是"测"这个动作，而是"口径的权威性"。

### 0.1 定位一句话（建议）

> **A unified yardstick for LLM inference.** 给大模型推理一把统一的尺子：同协议测量、跨环境对比、长期基线。

README 叙事主线："秦统一度量衡，统一的是天下的斤两；它统一的是大模型性能的口径。"
（§5 原"零依赖单二进制"一句降级为技术特性副标题。）

### 0.2 该定位对现状的要求（差距盘点）

| # | 要求 | 现状 | 差距 / 动作 |
|---|---|---|---|
| 1 | **测量协议版本**（TTFT/TPS 定义、请求数策略、分位数、多轮合并规则） | 口径在代码里，未版本化 | 固化为 protocol v1，版本号进 `/api/config` 与库记录；后续口径变更走 v2 |
| 2 | **环境指纹**（每条记录挂硬件/栈/配置） | `test_records` 无 env 字段，记录回答不了"哪块卡、哪个栈、什么量化" | run/record 增加环境快照（主机别名 + GPU/模型/栈版本/部署配置/数据集+seed） |
| 3 | **结果交换**（N 个内网的结果上同一张表） | 有 export.csv，无导入 | 加 import（SQLite/CSV/JSON）+ 跨环境对比视图（按环境指纹分组）；工作流 = 各内网本机跑 → 数据文件带回汇总机 |
| 4 | **校准**（剥离工具自身开销与 API 延迟） | 无 | 空请求基线步骤，报告 harness 开销 |
| 5 | **端点矩阵**（一个实例测多个端点） | 单一 `BASE_URL` | 并入 P1 YAML 多端点配置 |
| 6 | **脱敏**（发布不暴露内网主机名/IP） | 截图/文档含内部信息 | 环境指纹支持用户自定义"主机别名"（如 内网A） |
| 7 | **token 口径来源**（usage 实测 vs 字符估算可分辨） | `test_records` 无来源标记，TPS 数字无法分辨口径 | 加 `token_source` 列（'usage'/'estimate'），前端标记；跨环境对比数字必须可见口径 |
| 8 | **usage 能力协商**（不靠人猜网关支不支持 stream_options） | `STREAM_INCLUDE_USAGE` 默认 false，需预先知道 | 改三态 auto/true/false，auto = 首跑自动探测并持久化服务器能力（见 §0.3-A） |

### 0.3 测量方法论指令（2026-11-21 用户方向）

**A. `stream_options.include_usage` 默认传——触发真实 usage 返回**

- `STREAM_INCLUDE_USAGE` 改三态：`auto`（新默认）/ `true` / `false`。
- `auto` = 能力协商：首跑自动发一发带 `include_usage=true` 的请求——200 且流内含 usage →
  锁定实测口径（服务器能力持久化到 `endpoint_capabilities` 表，后续免探测）；
  400/422（未知字段被拒）→ 本次及后续回落无字段模式，转估算口径并在 run_log 记录。
- 边缘情况：200 但服务器静默吞掉字段（流里始终无 usage）→ 连续 K 个请求观察后标记"估算"并告警。
- 理由：vLLM≥0.4 / SGLang 支持 stream_options；TGI 与部分企业网关拒绝或忽略 → 不能一刀切默认 true，必须协商。

**B. Prefix cache 绕过机制（重要：现有方法论缺陷）**

- 问题：现代部署（vLLM APC / SGLang RadixAttention 等）默认开启前缀 KV 缓存；
  当前工具每次运行抽 20 题、各并发级别/各轮**复用同一组文本**（140 请求仅 20 个唯一前缀），
  缓存开启的服务器上 ~120/140 全前缀命中——TTFT 测的是"缓存命中服务"而非"冷用户"，
  系统性偏低，且与未开缓存的环境不可比。**现有 811 行历史数据即受此偏差影响（开缓存环境）。**
- 设计（建议）：
  1. **prompt 头部随机 nonce**：每个请求的用户内容前缀加随机 12–16 hex（数 token）。
     前缀缓存从头匹配，头部不同 = 全 prompt 不可复用；**尾部 nonce 无效**（长前缀仍命中），必须放头部。
  2. **级别间轮换抽题**：每个并发级别独立抽题（不复用上一级的同一组），叠加 nonce 后运行内重合趋零。
  3. `CACHE_BUST=on` 默认开；可显式关（"缓存命中口径"数字也有意义，但必须标记口径）。
  4. **warmup**：每个 (模型, 级别) 测量窗口前丢 M 个 warmup 请求，排除首批 CUDA graph / 引擎启动噪声。
  5. 口径打标：bust 开/关写入协议版本与库记录。
- 预期：bust 后 TTFT 回到"冷 prefill"口径，数字会**显著高于**缓存命中口径——这是修正，不是回归。

**C. 可配置输入 / 输出 token 数（测量坐标标准化）**

- 新增配置：`INPUT_TOKENS`（目标输入长度）、`OUTPUT_TOKENS`（输出预算，`MAX_TOKENS` 语义升级）。
- 构造：nonce + 真实题目 + 模板填充至目标输入长度；无 tokenizer 时按字符预算（±15%，协议中标记），
  **tokenizer 集成（tiktoken/HF）从 P2 升入 P1**——精确构造 N token 输入需要它。
- 输出侧：服务器只能保证 `max_tokens` 上限、无法保证恰好产出 N token（EOS 提前停）→
  提示词引导长输出 + 上限 + **每记录实测 input/output tokens**（有 usage 取 usage，否则估算），
  同时报告"目标值"与"实际值"。
- 数据模型：`test_records` 增加 `input_tokens_avg` / `output_tokens_avg` →
  每条记录的坐标 = (输入长, 输出长, 并发级) —— 跨环境对比先对齐坐标再比 TTFT/TPS，
  即"度量衡"的"同度量"；TTFT 在冷 prefill（bust）下按配置输入长测量，与 vLLM bench / genai-perf 口径对齐。

**综合**：A+B+C 合称 protocol v2（实测 tokens + 冷 prefill bust + 固定 (in,out) 预算）；
每条记录带协议版本，趋势图**不得混用 v1/v2**（历史 811 行 = protocol v1，只读保留）。

### 0.4 对清单与计划的影响

- P0 追加：协议版本 + 口径文档、`token_source` 列、环境指纹、脱敏主机别名；
- P1 追加：import + 跨环境对比、校准、usage 能力协商、cache bust + warmup、token 预算（in/out）；
- P2 → P1：tokenizer 集成；
- 发布周期：10–14 人日 → **约 13–20 人日**（§6 计划表相应顺延）。

## 1. 为什么"独立开源"更合适

### 1.1 两者的产品身份不同

| 维度 | QueQiao-Router | 本项目（压测器） |
|---|---|---|
| 核心价值 | 路由正确性、可用性、故障转移 | 测量可信度、可复现、可对比 |
| 使用者 | 网关运维 / 平台组 | 模型/平台/SRE、以及外部社区 |
| 变更频率 | 高（日志里能看到 b677→b722 的快速迭代） | 低（方法论、指标口径应稳定） |
| 版本语义 | 内部构建号（0.2.722） | 对外语义化版本（用户要引用"v1.0 的 P99 口径"） |
| 失败代价 | 请求失败 | 数字错误 → 决策错误 |

把压测器塞进一个高频迭代的网关，最直接的后果是：**用户无法把"某次测得的数字"钉在某个稳定版本上**。
而"可复现的版本"恰恰是压测工具最重要的资产。

### 1.2 测量有效性：进程内合并会引入混淆变量

- QueQiao 用 128 个 worker 线程 + mimalloc + simd-json + 审计写入 + Prometheus 直方图；
  压测跑在同一进程里，CPU/内存/连接池与业务流量互相争抢，测出来的 TTFT 会被网关自身负载污染。
- 独立进程（同一主机、`--network=host`）能给出更接近"只测上游"的数字；需要端到端数字时再显式选择"经网关"模式。
- 合并后"网关模式"的请求还会进审计库/指标滑窗，进一步干扰被动监控——绕不开打标/排除的复杂度。

### 1.3 代码耦合成本 > 复用收益

真正可复用的只有：连接池、模型列表缓存、日调度、面板外壳。合计约 300 行等价能力；
而要付出的代价是：rusqlite→sqlx 迁移（250 行）、Chart.js→ECharts 重写（1.2k 行）、
配置从 env→YAML 热重载、跟随 QueQiao 的 schema/CI/版本规范，以及**长期的双向回归成本**。
换个角度：合并后它是 35k 行仓库里一个约 2k 行的非核心模块，最容易在重构中腐烂。

### 1.4 开源的外部价值

现有 LLM 压测工具要么是 Python 脚本/研究框架（`genai-perf`、`evalscope`、`vLLM bench`、`llmperf`），
要么是通用压测器（`k6`、`vegeta`、`locust`）。缺的是**运维向的"单二进制 + 自带面板 + 可定时基线"**：

- 零依赖：Rust 单文件、SQLite 内嵌、无 Python/GPU 环境要求；
- OpenAI 兼容即可用：自动拉 `/v1/models`，模型 × 并发自动出矩阵；
- 时间维度：每天基线快照 + 趋势/对比，而不是一次性的报告；
- 错误可归因：401/429/5xx/空流/超时分别计数；
- 多架构镜像即拉即用。

这类工具天然面向"私有化/内网大模型服务"的团队（也正是你们自己的场景），受众明确，传播成本低。

## 2. 什么情况下才应该合并（保留判断）

1. **只服务内部、且团队只有 1–2 人**：那么多一个服务就是多一份运维，同镜像双进程（sidecar）比合并代码库更划算。
2. **需要闭环路由**：若 QueQiao 以后要"按实测 TTFT 动态调权/摘除后端"，需要的是**常驻探针（prober）**，
   约 200 行，嵌进网关合理；但那是"探针"，不是"压测矩阵 + 趋势面板"。
3. **对外发布不是目标**：如果不打算开源、不需要外部用户，合并可以减少一个部署单元。

反过来，只要满足任意一条——想要外部用户/社区、需要长期可比的基线、需要独立演进版本——就应保持独立。

## 3. 推荐形态：独立产品 + 官方集成

```
                 ┌─────────────────────────────┐
  浏览器 ───────►│  压测器（独立二进制/容器）    │──► 直连 backend A/B/C
                 │  单二进制 + SQLite + 面板    │──► 或经 QueQiao 网关
                 └──────────┬──────────────────┘
                            │ 只读：config.yaml / /dashboard/api/backends
                            ▼
                 ┌─────────────────────────────┐
                 │      QueQiao-Router          │
                 └─────────────────────────────┘
```

集成点（都很薄，互不绑死）：

1. **后端清单导入**：`health-checker import-queqiao ../config.yaml`（只读）或调用新增的只读
   `GET /dashboard/api/backends`，生成"每个后端一行"的目标矩阵；UI 里 base_url 脱敏。
2. **部署配方**：docker-compose 示例，压测器与网关同主机 `--network=host`，共享 `data/` 挂载。
3. **面板互联**：QueQiao 的 `/dashboard` 导航加一个可配置链接（1 行 HTML + 1 个配置项），指向压测器；不合并代码。
4. **结果互认**：压测器可选把结果推给 QueQiao 的 Prometheus（`pushgateway` 或文本文件），或在网关侧加
   `queqiao_bench_*` 指标命名空间；两边都保留自己的真相源。

## 4. 开源前的"必须做"清单（按优先级）

### P0：不修就不能公开

| # | 项 | 现状 | 动作 |
|---|---|---|---|
| 1 | License | 无 | 加 `LICENSE`（建议 Apache-2.0，与 QueQiao 一致，含专利授权） |
| 2 | README | 无（只有 AGENTS.md） | 英文主 + 中文副：一句话定位、截图/GIF、3 分钟快速开始、指标口径、FAQ、对比表 |
| 3 | 内部信息清洗 | 默认 `BASE_URL` 是内部域名；截图/文档含内部模型名、内网地址 | 默认改 `http://localhost:8000`；用 `model-a/model-b` 重做截图；删除内网 IP/域名/题库外的内部术语 |
| 4 | 安全 | 面板与触发接口无鉴权；CORS 默认同源（已修） | 加 `AUTH_TOKEN`（Bearer）+ 默认只监听 127.0.0.1，公开部署必须显式放开 |
| 5 | 冒烟 | 无 `/healthz` | 加 `/healthz` + 可选的 `--dry-run` |
| 6 | CI | 无 | GitHub Actions：`fmt`/`clippy -D warnings`/`test`/双架构 buildx/Release 附件/ghcr 推送 |
| 7 | 合规 | 图标含第三方厂商 logo | 保留则加 `NOTICE` 说明商标归属；或换成通用图标 |
| 8 | 仓库卫生 | 根目录有 `cross-gcc-*.rpm`、`core.*` 之类残留 | 删除并把规则写进 `.gitignore` |

### P1：决定"能不能被采用"

| # | 项 | 原因 |
|---|---|---|
| 9 | **配置文件（YAML/TOML）** | env-only 无法表达"多端点、多目标、数据集、调度"；env 保留为覆盖 |
| 10 | **数据集支持**（JSONL/纯文本）+ 内置题库 | 固定 510 道英文哲学题不适合所有人；支持 ShareGPT 等公开数据集 |
| 11 | **到达率模式（RPS）** | 并发梯度只回答"极限在哪"，RPS 模式回答"线上 QPS 下延迟多少"；再加 warmup/丢弃前 N 秒 |
| 12 | **口径文档** | TTFT/TPS/输出速度的定义、token 统计（usage vs 估算）、分位数、多次运行合并规则 |
| 13 | **Prometheus `/metrics`**（可选） | 接入现有监控/Grafana；也方便和 QueQiao 的指标并列 |
| 14 | **SLA 判定 + 退出码** | CI 里做"性能回归门禁"：`--max-p95 800ms --min-tps 30` |

### P2：v1.x 加分项

- tokenizer 集成（tiktoken / HF tokenizers，替代 `len/4` 估算）；
- A/B 对比两个端点（同一天、同数据集，出一张差异表）；
- 结果导出 JSON/HTML 报告（可归档、可贴 PR）；
- Kubernetes Job 模式（跑完即退、结果推到对象存储）；
- Helm Chart / Grafana 面板 JSON；
- 失败注入与超时矩阵（测网关的降级行为）。

## 5. 命名与定位

定位一句话（建议直接用）：

> **A zero-dependency, single-binary LLM inference load tester with a built-in baseline dashboard.**
> 单二进制、零依赖、自带基线面板的 OpenAI 兼容推理压测器。

> 不建议继续叫 `health-checker`：它既与通用的"健康检查"撞名，也无法表达"压测 + 基线"。

### 5.1 撞名排查记录（2026-11-21）

- **Benchline 被否决**（用户不喜欢该名称，2026-11-21）；原候选 LLMeter / StreamProbe 也同步被排查否决。
- 公开检索（GitHub / npm / crates.io / 论文 / 产品站）结果；"未撞"仅表示公开检索未发现直接同名，
  **发布前须在 crates.io / GitHub / npm 做最终复核 + 商标检索**（本环境 web_fetch 不可用，部分核验基于搜索摘要）。

| 名称 | 撞名 / 风险 | 出处 |
|---|---|---|
| TokenBench | 已占：视频重建基准（Alibaba OmniDoc-TokenBench，ICCV 2025） | arXiv / ICCV |
| TokBench | 已占：视觉 tokenizer 基准（ACM MM 2026 Oral） | ACM |
| StreamBench | 已占：NeurIPS 2024 论文 + 内存带宽/AI 推理 bench 工具 | ACM / GitHub |
| TokenMeter | 已占：token 成本归因工具（Zenodo 2026-09） | Zenodo |
| LLMPulse | 已占：llmpulse.ai，Rust 写的 AI 可见性 CLI | llmpulse.ai |
| LLMeter / llmmeter | 已占：npm 可观测/成本追踪包（@amit641/llmmeter） | npm |
| LLM Speedtest | 已占：gitee LLM API 测速工具 + Go 版 llm-speedtest（dashboard/MCP） | gitee / GitHub |
| LLM Vitals | 已占：VS Code 状态栏扩展 + npm `llm-vitals` | VS Marketplace |
| LLMGauge | 已占：wumbolabs 的 LLM 评测 CLI | wumbolabs.dev |
| LLM-stethoscope | 已占：LLM 分析 App | GitHub |
| TokPress | 已占：基于 LLM tokenizer 的 JSON 压缩器 | zyvop.com |
| Siege*（SiegeLLM 等） | 语义污染：LLM jailbreak 研究论文即名 "Siege" | promptfoo |
| llm-ping | 已占：Rust LLM API 逐段延迟诊断（cargo install） | GitHub |
| QuestBench / Q-Bench | 已占：DeepMind questbench + 视觉语言 Q-Bench | GitHub / arXiv |
| QueBench | 弱信号：中文评测文章出现 PC 基准 "QueBench R20"，来源不明 | 博客 |
| QuePress | 未撞 | — |
| TTFT | 未发现同名项目（术语本身通用，但无工具以此命名） | — |
| FirstTok | 未撞 | — |

- 现有格局（竞品清单，供定位对比）：perftok、scalebench、llmsim、llmperf、genai-perf、
  vLLM bench、evalscope、probelm、llmfit、LLMetrics、ProviderBench……
  大多为 Python / CLI 一次性报告，缺"运维向单二进制 + 自带面板 + 定时基线 + 错误归因"的组合。

### 5.2 新候选（待用户确认，未实施任何改动）

| 候选 | 含义 | 理由 | 撞名 |
|---|---|---|---|
| **TTFT**（首推，若定位中立通用工具） | 指标本名 Time To First Token | 领域第一指标；4 个字母，二进制名即 `ttft`（`fio` / `ping` / `iperf` 的命名先例）；Docker 镜像 `ttft:v1.0.0` 简洁；代价：名字只指向一个指标（工具同时报 TPS），靠 tagline 补位 | 未发现同名项目 |
| **FirstTok**（次选） | 首 token | 造词，指向测量核心，易做商标；对外人略抽象 | 未撞 |
| **QuePress**（条件候选） | Que（鹊）+ Press（压测） | 若日后挂 QueQiao 家族，品牌连贯性最强（鹊桥 + 压测，中英双关）；与"完全独立"定位冲突，故仅作条件项 | 未撞 |
| **QueBench**（备选） | Que + bench | 家族 + 诚实；"bench" 后缀拥挤，且有弱撞名信号 | 弱信号 |

### 5.3 中国文化隐喻候选（2026-11-21 补充，公式：文化意象 + 功能词）

用户要求仿照「QueQiao-Router」（鹊桥 = 牛郎织女星话里的天界意象，Router = 项目本质）的命名公式，
功能词候选：**Press**（压测）/ **Bench**（基线基准）/ **Probe**（探针）。

| 候选 | 意象出处 | 与工具的契合 | 撞名核验 |
|---|---|---|---|
| **ChengPress** | 杆秤：中国最古典的度量器；「cheng」兼 秤（称重）/ 程（里程、路程）/ 称（称量）三重音；杆秤上的**定盘星**是所有称量的零点 = 本项目「每日基线」的语义 | 意象最"中国"（杆秤无西方对应物），定盘星 = 基线故事与核心功能一一对应 | 组合名未撞 |
| **HengPress** | 衡：权衡 / 衡器 / **玉衡**（北斗第五星，"平衡之星"）；与鹊桥同属天上星宿家族（牛郎织女亦星） | "鹊桥是星间的桥，玉衡是星间的秤"——与 QueQiao 家族同一天空，品牌连贯性最强 | 组合名未撞（独名 Yuheng 已被企业知识库平台占用，属风险点） |
| **QuanPress** | **权 = 杆秤的秤砣**：《说文》本义"黄华木"（树），假借为秤锤；杜预《左传》注："权，秤锤也"；《孟子·尽心上》"嫂溺，援之以手者，权也"——秤砣随物滑动以称其重，故生"变通、衡量"义；度量衡之"衡"为权重类，权即其中实物（秦汉有检校市制的标准砝"权量"）。词源链：秤砣 → 称量 → 权衡（衡量利弊）→ 权力/权利（"能定秤者掌权"）——今天"权力"一词本是一个秤砣 | 三重语义全命中：① 秤砣沿秤杆滑动，给每样东西称出"真重" = 压测给每个模型称出真实容量；② 权衡 = 衡量决断 = 压测即权衡；③ 权力 = 定排名、加冕魁首的裁断力。且与 ChengPress（整杆秤）、HengPress（秤杆/玉衡）构成"秤-衡-权"一杆秤三件，家族可延展（定盘星、秤盘留白给未来产品） | 组合名 QuanPress 未撞；**QuanBench 形式已撞**（Quanbench / QuanBench+：LLM 量子代码生成基准，GitHub + HuggingFace）。注意：LLM 社区口语中 "quan" 亦指"千问"（Qwen），属轻微语义沾染 |
| **FamaBench** | 砝码：天平上的**标准重量**（reference weight） | 压测工具就是"基准砝码"：所有模型数字都相对你的基线校准——语义最贴切的隐喻 | 组合名未撞；存在轻度近似 FAMBench（facebookresearch，workload 基准），视觉相近需注意 |
| GuiBench | 圭：圭表之圭（汉代测量太阳、定出回归年长的科学仪器）；**圭臬** = 标准；「gui」兼 圭 / 规（规矩之圆规）/ 贵 | 古代科学计量仪 + "无以名之无以言之"的标准意象 | 组合名未撞；单字歧义多（归/贵/轨） |
| ShijianBench | 试剑 / 时间 双关：试其锋芒 + 测其光阴 | 延迟工具量的是"时间"，压测是"试剑"，一语双关 | 组合名未撞；独词过泛（时间） |
| DuokuiBench | 夺魁：一举夺魁，魁 = 榜首 | 压测排名、为模型"加冕"的榜单语义 | 组合名未撞（独词仅撞人名） |
| WendingBench | 问鼎：楚子问鼎、挑战霸主 + 稳定 双关 | "一压测便知谁堪承鼎"，SLA 门禁语义 | 弱撞名（DSH 插件 dsh-wending-ssh-manager 用词） |

已排除（撞名/风险）：玉衡 Yuheng（独名已被企业知识库平台与 OSM 工具占用）、璇玑 Xuanji（璇玑 AI 管家 + 玄机 Claude 客户端双双占用）、把脉 Baimai（深圳 Baimai Technology 工业检测公司）、天枢 Tianshu（tianshu-harness + tianshu-agent-os 占用）、QuanBench（Quanbench/QuanBench+ LLM 量子代码基准已占 Bench 形式）。

> 首推（2026-11-22 定论）：**QuanHeng-Bench**（权衡·基准）——词根见 §5.4，可用性已完成注册表级核验，见 §5.5。
> 次选 **HengPress**（单字"衡"）、**ChengPress**（杆秤）、**QuanPress**（秤砣）。
> 注意：最终发布前仍须做一次商标检索（GitHub/crates.io/npm/PyPI 已核验，见 §5.5）。

### 5.4 「QuanHeng」评估（2026-11-22 用户提议 QuanHeng-Brench）

**结论：词根 QuanHeng（权衡）是本项目迄今最好的名字，强于此前全部候选。**

理由：

1. **它是真词，不是生造词**：「权衡」= 衡量、比较、斟酌取舍，中文里无需解释。
2. **它字面上就是一杆完整的秤**：权 = 秤砣，衡 = 秤杆，二字合起来 = 整杆秤 + 称量动作本身。
   与用户确认的定位"不同内网部署的**度量衡**"同源——度量**衡**的"衡"即此衡。
3. **它是工具的功能描述**：跨环境对比 = 权衡；压测决策 = 权衡。名与实一次对齐。
4. **完全符合 QueQiao-Router 公式**：[文化意象 QuanHeng][本质 Bench]，两词连字符，与鹊桥-Router 同构。
5. **撞名干净**：公开检索仅见个人 ID（2002 年病毒作者署名、gitcode 用户 quanhengli），无同名软件/基准项目。

风险与注意事项：

| 项 | 说明 |
|---|---|
| 「权衡」在中文技术语境常作"trade-off"解 | 可能被误读为"架构权衡分析工具"而非性能度量工具；需要后缀或 tagline 消歧（故建议保留功能词） |
| **QuanBench 已被占用** | QuanBench（LLM 量子代码生成基准，IEEE 2026 + arXiv 2610.28678 + GitHub/HuggingFace）——"Quan…Bench" 形态有视觉邻接风险，搜索词可能混排 |
| "quan" 单独出现时指 Qwen | 中文 LLM 社区口语习惯；写作 QuanHeng 两音节后影响较小 |
| 读音 | quán héng；英文读者易读作 "kwan-heng"，可接受 |

**关于「Brench」——不建议采用**（两个独立理由）：

1. 疑似 **Bench** 的笔误：对外发布后每个看到的人都会怀疑拼错，搜索/记忆成本高；
2. 即便有意为之，**Brench 已是既有工具名**：Cornell Bril 编译器课程的 benchmark runner
   （[brench](https://capra.cs.cornell.edu/bril/tools/brench.html)，"a simple benchmark runner to help you measure
   the impact of optimizations"）——与本项目同属"跑基准、比差异"的工具，语义直接相撞。

**后缀候选（待拍板）**：

| 形态 | 评价 |
|---|---|
| **QuanHeng-Ruler** | 最贴"统一度量衡"定位（统一的是尺）；"Ruler" 撞名远少于 "Bench"；与鹊桥-Router 同为 [意象][本质] |
| QuanHeng-Bench | 最直白、符合惯例；但"bench" 后缀拥挤 + QuanBench 邻接 |
| QuanHeng（无后缀） | 最简洁、撞名最干净；但"权衡"的 trade-off 歧义无后缀消歧——且该方向已有同类占用（见 §5.5） |
| QuanHeng-Gauge / QuanHeng-Meter | 计量仪器语义准确，撞名少；英文语感略生硬 |

### 5.5 QuanHeng-Bench 可用性核验（2026-11-22，注册表直查，非搜索摘要）

| 目标 | 结果 | 结论 |
|---|---|---|
| crates.io `quanheng` / `quanheng-bench` / `quanheng-ruler` | 全部 404 | 可用（对照组 `llm-bench` 返回 200，证明检测有效） |
| npm `quanheng` / `quanheng-bench` / `quanheng-ruler` | 全部 404 | 可用 |
| PyPI `quanheng` / `quanheng-bench` | 404 | 可用 |
| GitHub `quanheng-bench in:name` | **0 个仓库** | 组合名完全干净 |
| GitHub `quanheng in:name` | 13 个，其中 `yijuntuqi/quanheng` 是"AI 辅助的复杂决策工具（比较选项/因素/权重/代价）" | **裸名已有同类占用，且正是"权衡 = trade-off"误读方向** → 反而证明应带 `-Bench` 后缀消歧 |
| GitHub `quanbench in:name` | 5 个（量子代码生成基准 QuanBench/QuanBench+ 等） | 邻接风险为"视觉/搜索混排"，非同名冲突 |

**定论**：`QuanHeng-Bench` 在 GitHub / crates.io / npm / PyPI 四个命名空间均无人占用，可直接采用；
`-Bench` 后缀不只是惯例，它恰好把本项目与既有的 `quanheng`（决策/trade-off 工具）区分开。

命名落地约定（建议）：

| 项 | 取值 |
|---|---|
| 仓库名 / 项目名 | `quanheng-bench`（小写连字符）／显示名 `QuanHeng-Bench` |
| 中文名 | 权衡·基准（副标题："大模型推理性能的统一度量衡"） |
| crate 名 | `quanheng-bench` |
| 二进制名 | `quanheng`（参照 crate `ripgrep` → 二进制 `rg` 的惯例；如担心与决策工具 PATH 混淆，可退为 `qhbench`） |
| Docker 镜像 | `quanheng-bench:v1.0.0`（或 `ghcr.io/<org>/quanheng-bench`） |
| 环境变量前缀 | `QH_`（迁移期与现有变量名并存，`QH_BASE_URL` 等为别名） |

## 6. 发布计划（原约 10–14 人日；含 §0 定位与方法论指令后约 13–20 人日，见 §0.4）

| 天 | 内容 | 产出 |
|---|---|---|
| D1 | 仓库清洗 + LICENSE + README 骨架 + CI（fmt/clippy/test） | 可公开的骨架仓库 |
| D2–3 | YAML 配置（多端点/目标/调度/鉴权），env 兜底 | `config.example.yaml` + 迁移说明 |
| D4–5 | 数据集（JSONL/文本）+ 内置题库可选；token 估算口径文档 | `--dataset` 可用 |
| D5–6 | RPS 到达率模式 + warmup + SLA/退出码 | CI 可做性能门禁 |
| D7 | 鉴权 + `/healthz` + 可选 `/metrics` | 可安全暴露 |
| D8 | 内部信息清洗（默认 URL、截图、样例） | 无内部痕迹 |
| D9–10 | 文档：方法论、对比表、FAQ、快速开始、GIF | docs 站点（md 即可） |
| D11–12 | CI 双架构镜像 + Release 二进制 + 版本 tag；QueQiao 集成配方 | 首次 Release |
| D13–14 | 发布文章（中文：知乎/V2EX/掘金；英文：HN/r/LocalLLaMA/awesome-llm） | 冷启动 |

## 7. 与"合并"的最终对比

| 判据 | 合并进 QueQiao | 独立开源 + 集成 |
|---|---|---|
| 运维单元 | 1 个 | 2 个（同机，compose 一键） |
| 测量纯度 | 低（共享进程资源） | 高（可隔离） |
| 版本可引用性 | 差（跟随网关构建号） | 好（语义化版本） |
| 外部用户/社区 | 基本没有 | 有 |
| 对 QueQiao 的侵入 | 高（config/schema/UI/CI） | 零（只读配置 + 一个链接） |
| 长期维护成本 | 双倍回归 | 各自独立 |
| 复用收益 | 连接池/模型缓存/面板（≈300 行等价） | 通过适配拿回 80% |

**决策：走独立开源；合并仅保留"常驻探针"这一条后路（未来若做闭环路由再议）。**
