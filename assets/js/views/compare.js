// ---------------------------------------------------------------------------
// views/compare.js — 多模型对比：勾选（≥2）、TTFT/吞吐叠加、归一化雷达、并排指标表
// ---------------------------------------------------------------------------

import { html, raw, setHtml } from '../dom.js';
import { icon } from '../icons.js';
import {
  fmtDateLabel, fmtInt, fmtMs, fmtPct, fmtTps, fmtFixed, fmtDuration,
  fmtConcurrency, tokenParts,
} from '../format.js';
import {
  mountChart, destroyCharts, compareOverlayPreset, compareSuccessPreset, radarPreset,
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

const RADAR_METRICS = [
  { key: 'avg_ttft_ms', label: 'TTFT（越低越好）', lower: true },
  { key: 'p95_ttft_ms', label: 'P95（越低越好）', lower: true },
  { key: 'avg_output_speed_tps', label: '输出速度', lower: false },
  { key: 'avg_tps', label: '整体吞吐', lower: false },
  { key: 'success_rate', label: '成功率', lower: false },
];

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
        return html`<span class="cell-model" style="justify-content:flex-end;gap:6px">
          ${msValue(record.avg_ttft_ms)}
          <span class="badge badge--outline" title="成功率">${fmtPct(record.success_rate, 1)}</span>
        </span>`;
      },
    })),
  ];

  return renderTable({
    columns,
    rows,
    ariaLabel: '所选模型各并发 TTFT 对比',
    emptyText: '暂无可对比的并发记录',
  });
}

function radarData() {
  const labels = RADAR_METRICS.map((metric) => metric.label);
  const series = entries.map((entry) => ({ label: entry.model, data: [] }));

  RADAR_METRICS.forEach((metric, metricIndex) => {
    const values = entries.map((entry) => {
      const value = entry.summary[metric.key];
      return Number.isFinite(value) ? value : null;
    });
    const usable = values.filter((value) => value !== null);
    const min = usable.length ? Math.min(...usable) : 0;
    const max = usable.length ? Math.max(...usable) : 0;
    const range = max - min;

    values.forEach((value, entryIndex) => {
      if (value === null) {
        series[entryIndex].data[metricIndex] = 0;
        return;
      }
      if (range === 0) {
        series[entryIndex].data[metricIndex] = 100;
        return;
      }
      const normalized = metric.lower ? (max - value) / range : (value - min) / range;
      series[entryIndex].data[metricIndex] = Math.round((15 + 85 * normalized) * 10) / 10;
    });
  });

  return { labels, series };
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
        title: 'TTFT 与输出速度叠加',
        subtitle: '实线 = TTFT（左轴 ms）· 虚线 = 输出速度（右轴 t/s）· 每色一个模型',
        ariaLabel: '所选模型的 TTFT 与输出速度随并发变化叠加图',
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
        title: '归一化雷达',
        subtitle: '每项按所选模型 min/max 归一（15–100）· TTFT/P95 取倒数',
        ariaLabel: '所选模型综合能力归一化雷达图',
        filename: `compare-radar-${currentDate}.png`,
      })}
    </div>

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
          <h2 class="card__title">各并发 TTFT</h2>
          <p class="card__sub">括号内为成功率</p>
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
        sub: ['勾选 2–6 个模型，叠加 TTFT / 吞吐曲线，并查看归一化雷达与并排指标'],
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
  mountChart('compare-overlay', (theme) => compareOverlayPreset(entries, theme));
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
