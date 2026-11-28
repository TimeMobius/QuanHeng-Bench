// ---------------------------------------------------------------------------
// views/compare.js — 多模型对比：勾选（≥2）、Prefill/Decode 分图、能力雷达、能力评分表
// ---------------------------------------------------------------------------

import { html, raw, setHtml } from '../dom.js';
import { icon } from '../icons.js';
import {
  fmtDateLabel, fmtInt, fmtMs, fmtPct, fmtTps, fmtFixed, fmtDuration,
  fmtConcurrency, tokenParts,
} from '../format.js';
import {
  mountChart, destroyCharts, compareOverlayPreset, compareSuccessPreset, radarPreset,
  hasPrefillData,
} from '../charts.js';
import { chartCard } from '../components/chart-card.js';
import { createPopover } from '../components/popover.js';
import { renderTable } from '../components/data-table.js';
import { emptyState } from '../components/skeleton.js';
import {
  bindModelAvatars, bindTableScrollHints, modelAvatar, msValue, rateBar, tpsValue, tokenValue,
  viewHead,
} from '../components/ui.js';

const MAX_MODELS = 6;

const SUMMARY_METRICS = [
  { key: 'avg_ttft_ms', label: '平均 TTFT', unit: 'ms', better: 'lower' },
  { key: 'p95_ttft_ms', label: 'P95 延迟', unit: 'ms', better: 'lower' },
  { key: 'avg_output_speed_tps', label: '输出速度', unit: 'tps', better: 'higher' },
  { key: 'avg_tps', label: '整体吞吐', unit: 'tps', better: 'higher' },
  { key: 'success_rate', label: '成功率', unit: 'pct', better: 'higher' },
  { key: 'requests', label: '请求数', unit: 'count' },
  { key: 'tokens', label: 'Token 总量', unit: 'tokens' },
  { key: 'duration_secs', label: '总耗时', unit: 'secs' },
  { key: 'max_concurrency', label: '最大并发', unit: 'concurrency' },
];

/**
 * 雷达图表示「能力」而不是「指标」。
 *
 * 直接拿 TTFT / P95 / 输出速度 画雷达有两个问题：量纲不同、方向不同，
 * 而且 P95 与 TTFT 高度相关（同一个维度的两倍权重）。
 *
 * 这里把一次压测拆成五个正交能力，各自换算成 0–100 分：
 *
 *   Prefill  首 token 能力：prefill 越快分越高（TTFT 取对数）
 *   Decode   持续解码能力：首字之后的输出速度
 *   并发承载 稳定承载能力：成功率仍达标（≥95%）的最高并发级别
 *   综合吞吐 端到端产能：整体 token 吞吐（含排队与首字时间）
 *   成功率   请求可靠性
 *
 * 归一化采用**固定锚点**而非所选模型间的 min/max。相对归一化会让
 * "每次都有某个模型拿 100 分"，不同批次挑选模型时分值不可比；
 * 固定锚点的分数在任何对比组合下都稳定。
 */
const CONCURRENCY_SLO = 95; // 成功率达标线（%），用于判定「稳定承载的最高并发」

const CAPABILITIES = [
  {
    key: 'prefill',
    label: 'Prefill',
    hint: '首 token 能力',
    formula: '100 − 40·log10(TTFT / 100ms)，夹取 0–100',
    raw: (entry) => entry.summary.avg_ttft_ms,
    rawText: (value) => (Number.isFinite(value) ? fmtMs(value) : '—'),
  },
  {
    key: 'decode',
    label: 'Decode',
    hint: '持续解码能力',
    formula: '50 + 50·log10(首字后 TPS / 10)，夹取 0–100',
    raw: (entry) => entry.summary.avg_output_speed_tps,
    rawText: (value) => (Number.isFinite(value) ? fmtTps(value) : '—'),
  },
  {
    key: 'concurrency',
    label: '并发承载',
    hint: '成功率 ≥95% 的最高并发',
    formula: '100 · log2(级别) / log2(日期内最高级别)',
    raw: (entry) => stableConcurrency(entry),
    rawText: (value) => (Number.isFinite(value) && value > 0 ? fmtConcurrency(value) : '—'),
  },
  {
    key: 'throughput',
    label: '综合吞吐',
    hint: '端到端产能',
    formula: '50 + 50·log10(整体 TPS / 10)，夹取 0–100',
    raw: (entry) => entry.summary.avg_tps,
    rawText: (value) => (Number.isFinite(value) ? fmtTps(value) : '—'),
  },
  {
    key: 'success',
    label: '成功率',
    hint: '请求可靠性',
    formula: '成功率百分比直接作为得分',
    raw: (entry) => entry.summary.success_rate,
    rawText: (value) => (Number.isFinite(value) ? fmtPct(value, 1) : '—'),
  },
];

/** 成功率仍达标（≥95%）的最高并发级别；全部达标时取记录里的最高级。 */
function stableConcurrency(entry) {
  const usable = (entry.records || [])
    .filter((record) => Number(record.request_count) > 0)
    .slice()
    .sort((a, b) => a.concurrency - b.concurrency);
  if (!usable.length) return null;
  let best = null;
  usable.forEach((record) => {
    if (Number(record.success_rate) >= CONCURRENCY_SLO) best = record.concurrency;
  });
  return best;
}

const clamp = (value, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, value));

/** 能力 → 0–100 分（固定锚点，见 CAPABILITIES 注释）。 */
function capabilityScore(key, entry) {
  switch (key) {
    case 'prefill': {
      const ttft = entry.summary.avg_ttft_ms;
      if (!Number.isFinite(ttft) || ttft <= 0) return null;
      return clamp(100 - 40 * Math.log10(ttft / 100));
    }
    case 'decode': {
      const tps = entry.summary.avg_output_speed_tps;
      if (!Number.isFinite(tps) || tps <= 0) return null;
      return clamp(50 + 50 * Math.log10(tps / 10));
    }
    case 'throughput': {
      const tps = entry.summary.avg_tps;
      if (!Number.isFinite(tps) || tps <= 0) return null;
      return clamp(50 + 50 * Math.log10(tps / 10));
    }
    case 'success': {
      const rate = entry.summary.success_rate;
      return Number.isFinite(rate) ? clamp(rate) : null;
    }
    case 'concurrency': {
      const level = stableConcurrency(entry);
      if (!level) return null;
      const ceiling = concurrencyCeiling();
      if (!ceiling) return null;
      return clamp((100 * Math.log2(level)) / Math.log2(ceiling));
    }
    default:
      return null;
  }
}

/** 归一化分母：当天数据里出现过的最高并发级别（跨模型固定，保证分数可比）。 */
function concurrencyCeiling() {
  let ceiling = 0;
  entries.forEach((entry) => {
    (entry.records || []).forEach((record) => {
      if (Number(record.request_count) > 0) ceiling = Math.max(ceiling, Number(record.concurrency) || 0);
    });
  });
  return ceiling;
}

let selection = [];
let entries = [];
let currentDate = '';
let popover = null;

function modelsWithData(ctx) {
  const dashboard = ctx.state.dashboard;
  const models = (dashboard && dashboard.models) || [];
  return models.filter((model) => model.has_data && Array.isArray(model.records) && model.records.length);
}

function resolveSelection(ctx, models) {
  const ids = models.map((model) => model.id);
  const fromRoute = ctx.route.params && ctx.route.params.get('models');
  const candidate = fromRoute
    ? String(fromRoute).split(',').map((item) => item.trim()).filter(Boolean)
    : (ctx.state.compareModels || []);
  const filtered = candidate.filter((id) => ids.includes(id));
  if (filtered.length >= 2) return filtered.slice(0, MAX_MODELS);
  if (filtered.length === 1) {
    const fallback = ids.find((id) => id !== filtered[0]);
    return fallback ? [...filtered, fallback].slice(0, MAX_MODELS) : filtered;
  }
  return ids.slice(0, Math.min(3, MAX_MODELS));
}

function buildEntries(ctx) {
  const models = modelsWithData(ctx);
  return selection.map((id) => {
    const model = models.find((item) => item.id === id);
    if (!model) return null;
    const records = (model.records || []).slice().sort((a, b) => a.concurrency - b.concurrency);
    return {
      model: model.id,
      modelRef: model,
      summary: model.summary || {},
      records,
    };
  }).filter(Boolean);
}

function formatMetric(unit, value) {
  if (!Number.isFinite(value)) return '—';
  switch (unit) {
    case 'ms': return fmtMs(value);
    case 'tps': return fmtTps(value);
    case 'pct': return fmtPct(value);
    case 'tokens': return tokenParts(value).exact;
    case 'secs': return fmtDuration(value);
    case 'concurrency': return fmtConcurrency(value);
    case 'count': return fmtInt(value);
    default: return fmtFixed(value, 2);
  }
}

function bestValueFor(metric) {
  const values = entries
    .map((entry) => entry.summary[metric.key])
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return metric.better === 'lower' ? Math.min(...values) : Math.max(...values);
}

function summaryTable() {
  const columns = [
    { key: 'label', label: '指标', align: 'left', render: (row) => html`<strong>${row.label}</strong>` },
    ...entries.map((entry) => ({
      key: entry.model,
      label: entry.model,
      sortable: false,
      render: (row) => {
        const value = entry.summary[row.key];
        const text = formatMetric(row.unit, value);
        const best = row.better ? bestValueFor(row) : null;
        const isBest = best !== null && Number.isFinite(value) && value === best;
        return html`<span class="cell-model" style="justify-content:flex-end;gap:6px">
          <span class="${isBest ? 'num-strong is-good' : ''}">${text}</span>
          ${isBest ? html`<span class="badge badge--good">最优</span>` : raw('')}
        </span>`;
      },
    })),
  ];

  return renderTable({
    columns,
    rows: SUMMARY_METRICS,
    ariaLabel: '所选模型汇总指标并排对比',
    emptyText: '暂无数据',
  });
}

function concurrencyTable() {
  const levels = [];
  entries.forEach((entry) => entry.records.forEach((record) => {
    if (!levels.includes(record.concurrency)) levels.push(record.concurrency);
  }));
  levels.sort((a, b) => a - b);

  const rows = levels.map((level) => ({ level }));
  const columns = [
    {
      key: 'level',
      label: '并发',
      align: 'left',
      render: (row) => html`<strong>${fmtConcurrency(row.level)}</strong>`,
    },
    ...entries.map((entry) => ({
      key: entry.model,
      label: entry.model,
      render: (row) => {
        const record = entry.records.find((item) => item.concurrency === row.level);
        if (!record) return html`<span class="text-faint">—</span>`;
        // 每个并发档位同时给出 TTFT 与 Decode：两行都带标签，
        // 避免只显示首 token 延迟而让人以为这一档没有解码吞吐数据。
        return html`<span class="metric-pair">
          <span class="metric-pair__row">
            <span class="metric-pair__label">TTFT</span>
            <span class="metric-pair__value">${msValue(record.avg_ttft_ms)}</span>
          </span>
          <span class="metric-pair__row">
            <span class="metric-pair__label">Decode</span>
            <span class="metric-pair__value">${tpsValue(record.avg_output_speed_tps)}</span>
          </span>
          <span class="metric-pair__row">
            <span class="metric-pair__label">成功率</span>
            <span class="metric-pair__value">
              <span class="badge badge--${successTone(record.success_rate)}">${fmtPct(record.success_rate, 1)}</span>
            </span>
          </span>
        </span>`;
      },
    })),
  ];

  return renderTable({
    columns,
    rows,
    ariaLabel: '所选模型各并发 TTFT 与 Decode 输出速度对比',
    emptyText: '暂无可对比的并发记录',
  });
}

function radarData() {
  const labels = CAPABILITIES.map((capability) => capability.label);
  const series = entries.map((entry) => ({
    label: entry.model,
    data: CAPABILITIES.map((capability) => {
      const score = capabilityScore(capability.key, entry);
      return score === null ? 0 : Math.round(score * 10) / 10;
    }),
  }));
  return { labels, series };
}

/**
 * 能力评分表：把雷达图背后的算式摊开，避免"归一化"变成黑箱。
 * 每行一个能力维度，列出算法与各模型的原始值 / 得分。
 */
/** 成功率徽标配色：达标（≥95%）绿、可用（≥80%）黄、其余红。 */
function successTone(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value)) return 'outline';
  if (value >= 95) return 'good';
  if (value >= 80) return 'warn';
  return 'bad';
}

function capabilityTable() {
  const columns = [
    {
      key: 'capability',
      label: '能力',
      align: 'left',
      render: (row) => html`
        <span class="cap-cell">
          <strong>${row.label}</strong>
          <span class="cell-sub">${row.hint}</span>
        </span>`,
    },
    {
      key: 'formula',
      label: '换算方式',
      align: 'left',
      render: (row) => html`<span class="cell-sub cell-sub--mono">${row.formula}</span>`,
    },
    ...entries.map((entry) => ({
      key: entry.model,
      label: entry.model,
      sortable: false,
      render: (row) => {
        const score = capabilityScore(row.key, entry);
        const rawValue = row.raw(entry);
        const rawText = row.rawText(rawValue);
        return html`<span class="cell-model" style="justify-content:flex-end;gap:6px">
          <span class="${score !== null ? 'num-strong' : 'text-faint'}">${score === null ? '—' : fmtFixed(score, 1)}</span>
          <span class="cell-sub">${rawText}</span>
        </span>`;
      },
    })),
  ];

  return renderTable({
    columns,
    rows: CAPABILITIES,
    ariaLabel: '能力维度换算方式与各模型得分',
    emptyText: '暂无数据',
  });
}

/**
 * 左轴口径：有 input_tokens（protocol v2）就画 Prefill 有效吞吐，
 * 否则回退到 TTFT —— 历史 v1 记录没有输入 token 数，硬算会得出 0。
 */
function leftMetric() {
  return hasPrefillData(entries) ? 'prefill' : 'ttft';
}

function overlayTitle() {
  return leftMetric() === 'prefill'
    ? 'Prefill 与 Decode 吞吐叠加'
    : 'TTFT 与 Decode 输出速度叠加';
}

function overlaySubtitle() {
  if (leftMetric() === 'prefill') {
    return '实线 = Prefill 有效吞吐（输入 token ÷ TTFT）· 虚线 = Decode · 统一 t/s，对数刻度 · 均含排队与网络时间';
  }
  return '实线 = TTFT（左轴 ms，越低越好）· 虚线 = Decode（右轴 t/s）· 该日期为 protocol v1 记录，无输入 token 数，无法换算 Prefill 吞吐';
}

function resultsBody(ctx) {
  if (entries.length < 2) {
    return html`
      <section class="card">
        ${emptyState({
          iconName: 'compare',
          title: '请选择至少 2 个模型',
          text: '在上方「选择模型」里勾选要对比的模型，至少 2 个、最多 6 个。',
        })}
      </section>
    `;
  }

  const rad = radarData();

  return html`
    <div class="chart-grid">
      ${chartCard({
        id: 'compare-overlay',
        title: overlayTitle(),
        subtitle: overlaySubtitle(),
        ariaLabel: '所选模型预填充与解码吞吐随并发变化叠加图',
        wide: true,
        filename: `compare-overlay-${currentDate}.png`,
      })}
      ${chartCard({
        id: 'compare-success',
        title: '成功率对比',
        subtitle: '0–100%',
        ariaLabel: '所选模型各并发成功率对比折线图',
        filename: `compare-success-${currentDate}.png`,
      })}
      ${chartCard({
        id: 'compare-radar',
        title: '能力雷达',
        subtitle: 'Prefill / Decode / 并发承载 / 综合吞吐 / 成功率 · 0–100 分，固定锚点换算',
        ariaLabel: '所选模型五项能力得分雷达图',
        filename: `compare-radar-${currentDate}.png`,
      })}
    </div>

    <section class="card">
      <div class="card__head">
        <div class="card__titles">
          <h2 class="card__title">能力评分与算法</h2>
          <p class="card__sub">
            左侧为 0–100 分，右侧灰字为该项原始测量值；固定锚点换算，不同对比组合下分数可比
          </p>
        </div>
      </div>
      <div class="card__body card__body--flush" data-compare-capability>${capabilityTable()}</div>
    </section>

    <section class="card">
      <div class="card__head">
        <div class="card__titles">
          <h2 class="card__title">并排指标表</h2>
          <p class="card__sub">按 ${fmtDateLabel(currentDate)} 的汇总（按请求数加权）</p>
        </div>
      </div>
      <div class="card__body card__body--flush" data-compare-summary>${summaryTable()}</div>
    </section>

    <section class="card">
      <div class="card__head">
        <div class="card__titles">
          <h2 class="card__title">各并发明细</h2>
          <p class="card__sub">每个并发档位列出 TTFT（ms）、Decode 输出速度（t/s）与成功率</p>
        </div>
      </div>
      <div class="card__body card__body--flush" data-compare-levels>${concurrencyTable()}</div>
    </section>
  `;
}

function checkedList(ctx) {
  const models = modelsWithData(ctx);
  return html`
    <div class="check-list" role="group" aria-label="选择对比模型">
      ${models.map((model) => html`
        <button class="check-item" type="button" role="checkbox"
                aria-checked="${selection.includes(model.id) ? 'true' : 'false'}"
                data-compare-id="${model.id}">
          <span class="check-item__box" aria-hidden="true">${icon('check', { size: 10, className: '' })}</span>
          <span class="check-item__name">${model.id}</span>
          <span class="check-item__meta">${Number.isFinite(model.summary && model.summary.avg_ttft_ms) ? fmtMs(model.summary.avg_ttft_ms) : '—'}</span>
        </button>
      `)}
      ${models.length ? raw('') : html`<p class="date-empty">没有可对比的模型</p>`}
    </div>
  `;
}

function controls(ctx) {
  const models = modelsWithData(ctx);
  return html`
    <div class="controls">
      <div class="popover-wrap">
        <button class="btn btn-outline" type="button" id="compare-select-btn"
                aria-haspopup="dialog" aria-expanded="false" aria-controls="compare-select-panel">
          ${icon('sliders', { size: 14 })}选择模型
          <span class="badge badge--info">${selection.length}</span>
        </button>
        <div class="popover" id="compare-select-panel" role="dialog" aria-label="选择对比模型" hidden>
          <div data-compare-check-list>${checkedList(ctx)}</div>
          <div class="popover__foot">
            <span class="hint">2–${MAX_MODELS} 个模型</span>
            <button class="btn btn-ghost btn-sm" type="button" data-action="compare-all">全选</button>
          </div>
        </div>
      </div>
      <span class="hint">${models.length} 个模型有数据 · 对比日期 ${fmtDateLabel(currentDate)}</span>
      <div class="controls__spacer"></div>
      <a class="btn btn-outline btn-sm" href="${ctx.exportUrl(null)}">${icon('download', { size: 13, className: 'ico ico--sm' })}导出当日 CSV</a>
    </div>
  `;
}

export function render(ctx) {
  const dashboard = ctx.state.dashboard;
  if (!dashboard) return html`<div class="view"></div>`;

  const models = modelsWithData(ctx);
  currentDate = ctx.route.date || dashboard.date || ctx.state.date || ctx.state.today;

  if (models.length < 2) {
    return html`
      <div class="view" data-view="compare">
        ${viewHead({
          title: html`多模型对比`,
          badge: html`<span class="badge badge--outline">${fmtDateLabel(currentDate)}</span>`,
          sub: ['至少需要 2 个模型在同一日期有数据才能对比'],
        })}
        <section class="card">
          ${emptyState({
            iconName: 'compare',
            title: '可对比的模型不足',
            text: ctx.state.dashboard.models && ctx.state.dashboard.models.length
              ? '当前日期只有不到 2 个模型有数据。可以运行全量测试，或切换到其他日期。'
              : '还没有任何模型数据，先运行一次测试。',
            actions: [
              { label: '运行全部模型', action: 'run-test', kind: 'primary' },
              { label: '返回概览', action: 'go-overview' },
            ],
          })}
        </section>
      </div>
    `;
  }

  selection = resolveSelection(ctx, models);
  entries = buildEntries(ctx);
  if (typeof ctx.setCompareModels === 'function') ctx.setCompareModels(selection);

  return html`
    <div class="view" data-view="compare">
      ${viewHead({
        title: html`多模型对比`,
        badge: html`<span class="badge badge--outline">${fmtDateLabel(currentDate)}</span>`,
        sub: ['勾选 2–6 个模型，对比预填充与解码吞吐随并发的表现，并按能力维度看综合实力'],
      })}
      ${controls(ctx)}
      <div data-compare-body>${resultsBody(ctx)}</div>
    </div>
  `;
}

function updateChecks(root) {
  Array.prototype.forEach.call(root.querySelectorAll('[data-compare-id]'), (item) => {
    item.setAttribute('aria-checked', String(selection.includes(item.dataset.compareId)));
  });
  const counter = root.querySelector('#compare-select-btn .badge');
  if (counter) counter.textContent = String(selection.length);
}

function refreshBody(root, ctx) {
  entries = buildEntries(ctx);
  destroyCharts();
  const host = root.querySelector('[data-compare-body]');
  if (host) setHtml(host, resultsBody(ctx));
  updateChecks(root);
  bindTableScrollHints(root);
  mountCharts();
}

function mountCharts() {
  if (entries.length < 2) return;
  const rad = radarData();
  const left = leftMetric();
  mountChart('compare-overlay', (theme) => compareOverlayPreset(entries, theme, { left }));
  mountChart('compare-success', (theme) => compareSuccessPreset(entries, theme));
  mountChart('compare-radar', (theme) => radarPreset(rad.labels, rad.series, theme));
}

export function bind(root, ctx) {
  bindModelAvatars(root);
  bindTableScrollHints(root);

  const trigger = root.querySelector('#compare-select-btn');
  const panel = root.querySelector('#compare-select-panel');
  if (popover) popover.destroy();
  popover = createPopover({ trigger, panel });

  root.addEventListener('click', (event) => {
    const item = event.target.closest('[data-compare-id]');
    if (!item) return;
    event.preventDefault();
    const id = item.dataset.compareId;
    const next = new Set(selection);
    if (next.has(id)) {
      if (next.size <= 2) {
        ctx.toast('至少保留 2 个模型', { type: 'warn', duration: 2200 });
        return;
      }
      next.delete(id);
    } else {
      if (next.size >= MAX_MODELS) {
        ctx.toast(`最多对比 ${MAX_MODELS} 个模型`, { type: 'warn', duration: 2200 });
        return;
      }
      next.add(id);
    }
    const ordered = modelsWithData(ctx)
      .map((model) => model.id)
      .filter((modelId) => next.has(modelId));
    selection = ordered;
    if (typeof ctx.setCompareModels === 'function') ctx.setCompareModels(selection);
    if (typeof ctx.syncUrl === 'function') {
      ctx.syncUrl(ctx.hashFor('compare', {
        params: { models: selection.join(','), date: ctx.route.date || '' },
      }));
    }
    refreshBody(root, ctx);
  });

  root.addEventListener('click', (event) => {
    const selectAll = event.target.closest('[data-action="compare-all"]');
    if (!selectAll) return;
    event.preventDefault();
    selection = modelsWithData(ctx).map((model) => model.id).slice(0, MAX_MODELS);
    if (typeof ctx.setCompareModels === 'function') ctx.setCompareModels(selection);
    if (typeof ctx.syncUrl === 'function') {
      ctx.syncUrl(ctx.hashFor('compare', {
        params: { models: selection.join(','), date: ctx.route.date || '' },
      }));
    }
    refreshBody(root, ctx);
  });
}

export function mount(root, ctx) {
  if (typeof ctx.rememberCompare === 'function') ctx.rememberCompare(selection);
  mountCharts();
}

export function destroy() {
  if (popover) {
    popover.destroy();
    popover = null;
  }
}
