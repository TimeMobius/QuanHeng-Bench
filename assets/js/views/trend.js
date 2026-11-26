// ---------------------------------------------------------------------------
// views/trend.js — 跨日期趋势：模型 + 指标 + 并发 + 日期范围，数据来自 /api/trend
// ---------------------------------------------------------------------------

import { html, raw, setHtml } from '../dom.js';
import { icon } from '../icons.js';
import { fmtDateLabel, fmtInt, fmtPct, fmtMs, fmtTps, fmtFixed } from '../format.js';
import { api } from '../api.js';
import { mountChart, TREND_METRICS, METRIC_BY_KEY, trendPreset } from '../charts.js';
import { chartCard } from '../components/chart-card.js';
import { renderTable } from '../components/data-table.js';
import { emptyState } from '../components/skeleton.js';
import { bindTableScrollHints, viewHead } from '../components/ui.js';

let active = { model: '', metric: 'ttft', concurrency: '', range: '7' };
let requestId = 0;
const cache = new Map();

function modelsWithData(ctx) {
  const dashboard = ctx.state.dashboard;
  const models = (dashboard && dashboard.models) || [];
  return models.filter((model) => model.has_data);
}

function metricMeta() {
  return METRIC_BY_KEY[active.metric] || METRIC_BY_KEY.ttft;
}

function metricText(unit, value) {
  if (!Number.isFinite(value)) return '—';
  if (unit === 'ms') return fmtMs(value);
  if (unit === 'tps') return fmtTps(value);
  if (unit === 'pct') return fmtPct(value);
  return fmtFixed(value, 2);
}

function cacheKey() {
  return JSON.stringify({ model: active.model, metric: active.metric, concurrency: active.concurrency });
}

function subtractDays(dateStr, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!match) return dateStr;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function filterByRange(points, range) {
  if (range === 'all' || points.length <= 1) return points;
  const reference = points[points.length - 1].date;
  const days = range === '30' ? 30 : 7;
  const cutoff = subtractDays(reference, days - 1);
  return points.filter((point) => point.date >= cutoff);
}

function pointsTable(points) {
  const metric = metricMeta();
  const rows = points.slice().reverse();
  return renderTable({
    columns: [
      { key: 'date', label: '日期', align: 'left', render: (row) => html`<strong>${row.date}</strong>` },
      { key: 'value', label: metric.label, render: (row) => html`<span class="num-strong">${metricText(metric.unit, row.value)}</span>` },
      { key: 'request_count', label: '请求数', render: (row) => fmtInt(row.request_count) },
      {
        key: 'success_rate',
        label: '成功率',
        render: (row) => {
          const value = Number(row.success_rate);
          const tone = value >= 99 ? 'is-good' : value >= 80 ? 'is-warn' : 'is-bad';
          return html`<span class="${Number.isFinite(value) ? tone : ''}">${fmtPct(row.success_rate)}</span>`;
        },
      },
    ],
    rows,
    ariaLabel: `${metric.label} 历史数据点`,
    emptyText: '暂无数据点',
  });
}

function outputBody(points, ctx) {
  const metric = metricMeta();
  const filtered = filterByRange(points, active.range);
  const first = filtered[0];
  const last = filtered[filtered.length - 1];
  let deltaText = '';
  if (first && last && Number.isFinite(first.value) && Number.isFinite(last.value)
    && first.value !== 0 && filtered.length > 1) {
    const delta = ((last.value - first.value) / first.value) * 100;
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    deltaText = `较首日 ${arrow} ${fmtFixed(Math.abs(delta), 1)}%`;
  }
  const concurrencyText = active.concurrency ? `并发 ×${active.concurrency}` : '全部并发（按请求数加权）';
  const subtitle = [
    concurrencyText,
    `${fmtInt(filtered.length)} 个数据点`,
    filtered.length ? `${filtered[0].date} → ${filtered[filtered.length - 1].date}` : '',
    deltaText,
  ].filter(Boolean).join(' · ');

  const hasRangeData = filtered.length > 0;

  return html`
    <div class="view" data-trend-result>
      ${chartCard({
        id: 'trend-chart',
        title: `${metric.label} 趋势`,
        subtitle,
        ariaLabel: `${active.model} 的 ${metric.label} 跨日期趋势折线图`,
        filename: `trend-${active.model}-${active.metric}-${active.concurrency || 'all'}.png`,
        wide: true,
        empty: !hasRangeData,
        emptyText: '所选日期范围内暂无数据点，试试「全部」',
      })}

      <section class="card">
        <div class="card__head">
          <div class="card__titles">
            <h2 class="card__title">数据点</h2>
            <p class="card__sub">按日期倒序 · 成功率用于判断数据可信度</p>
          </div>
          <div class="card__actions">
            <span class="hint">${active.model} · ${concurrencyText}</span>
          </div>
        </div>
        <div class="card__body card__body--flush trend-table">
          ${pointsTable(filtered)}
        </div>
      </section>
    </div>
  `;
}

function paint(root, ctx, points) {
  const host = root.querySelector('[data-trend-output]');
  if (!host) return;
  setHtml(host, outputBody(points, ctx));
  bindTableScrollHints(root);
  const filtered = filterByRange(points, active.range);
  if (filtered.length) {
    mountChart('trend-chart', (theme) => trendPreset(filtered, active.metric, theme));
  }
}

async function load(root, ctx) {
  const host = root.querySelector('[data-trend-output]');
  if (!host) return;

  if (!active.model) {
    setHtml(host, emptyState({
      iconName: 'trend',
      title: '没有可绘制的模型',
      text: '当前日期没有任何有数据的模型。',
      actions: [{ label: '返回概览', action: 'go-overview', kind: 'primary' }],
    }));
    return;
  }

  const key = cacheKey();
  const cached = cache.get(key);
  if (cached) {
    paint(root, ctx, cached);
    return;
  }

  const token = ++requestId;
  setHtml(host, html`<div class="view">
    <div class="skeleton skeleton--chart"></div>
    <div class="skeleton skeleton--table"></div>
  </div>`);

  try {
    const response = await api.trend({
      model: active.model,
      metric: active.metric,
      concurrency: active.concurrency || '',
    });
    if (token !== requestId || !host.isConnected) return;
    const points = (response && response.points) || [];
    cache.set(key, points);
    paint(root, ctx, points);
    if (!points.length) {
      ctx.toast('该模型在该指标 / 并发下暂无历史数据', { type: 'info', duration: 3000 });
    }
  } catch (err) {
    if (token !== requestId) return;
    setHtml(host, html`<div class="view">
      <div class="error-state" role="alert">
        <p class="error-state__title">${icon('alert', { size: 16 })}趋势数据加载失败</p>
        <p class="error-state__text">${err.message || '请求 /api/trend 失败'}</p>
        <button class="btn btn-outline btn-sm" type="button" data-action="trend-retry">重试</button>
      </div>
    </div>`);
    ctx.notifyError(err, { title: '趋势数据加载失败' });
  }
}

function syncUrl(ctx) {
  if (typeof ctx.syncUrl !== 'function') return;
  ctx.syncUrl(ctx.hashFor('trend', {
    params: {
      model: active.model,
      metric: active.metric,
      concurrency: active.concurrency,
      date: ctx.route.date || '',
    },
  }));
}

function persist(ctx) {
  if (typeof ctx.setTrend === 'function') ctx.setTrend(active);
}

export function render(ctx) {
  const dashboard = ctx.state.dashboard;
  if (!dashboard) return html`<div class="view"></div>`;

  const models = modelsWithData(ctx);
  const config = dashboard.config || {};
  const levels = config.concurrency_levels || [1, 2, 4, 8, 16, 32, 64];
  const params = ctx.route.params;
  const stored = ctx.state.trend || {};

  const wantedModel = (params && params.get('model')) || stored.model || '';
  active.model = models.some((model) => model.id === wantedModel)
    ? wantedModel
    : (models[0] ? models[0].id : '');

  const metricParam = (params && params.get('metric')) || stored.metric || 'ttft';
  active.metric = METRIC_BY_KEY[metricParam] ? metricParam : 'ttft';

  const concurrencyParam = params ? params.get('concurrency') : null;
  active.concurrency = concurrencyParam !== null && concurrencyParam !== undefined
    ? String(concurrencyParam)
    : (stored.concurrency ? String(stored.concurrency) : '');

  active.range = ['7', '30', 'all'].includes(stored.range) ? stored.range : '7';

  if (!models.length) {
    return html`
      <div class="view" data-view="trend">
        ${viewHead({ title: html`跨日期趋势` })}
        <section class="card">
          ${emptyState({
            iconName: 'trend',
            title: '暂无趋势数据',
            text: '还没有任何模型的历史测试记录。',
            actions: [{ label: '运行全部模型', action: 'run-test', kind: 'primary' }],
          })}
        </section>
      </div>
    `;
  }

  const rangeButton = (value, label) => html`
    <button class="segmented__btn${active.range === value ? ' is-active' : ''}" type="button"
            data-trend-range="${value}" aria-pressed="${active.range === value ? 'true' : 'false'}">${label}</button>
  `;

  return html`
    <div class="view" data-view="trend">
      ${viewHead({
        title: html`跨日期趋势`,
        badge: html`<span class="badge badge--outline">${fmtDateLabel(ctx.route.date || dashboard.date || ctx.state.date || ctx.state.today)}</span>`,
        sub: ['选择模型 / 指标 / 并发，查看跨日期变化 · 汇总值按请求数加权'],
      })}

      <div class="controls">
        <div class="control">
          <label class="control__label" for="trend-model">模型</label>
          <select class="select" id="trend-model">
            ${models.map((model) => html`<option value="${model.id}"${model.id === active.model ? raw(' selected') : raw('')}>${model.id}</option>`)}
          </select>
        </div>
        <div class="control">
          <label class="control__label" for="trend-metric">指标</label>
          <select class="select" id="trend-metric">
            ${TREND_METRICS.map((metric) => html`<option value="${metric.key}"${metric.key === active.metric ? raw(' selected') : raw('')}>${metric.label}</option>`)}
          </select>
        </div>
        <div class="control">
          <label class="control__label" for="trend-concurrency">并发</label>
          <select class="select" id="trend-concurrency">
            <option value=""${active.concurrency === '' ? raw(' selected') : raw('')}>全部（加权）</option>
            ${levels.map((level) => html`<option value="${level}"${String(level) === String(active.concurrency) ? raw(' selected') : raw('')}>×${level}</option>`)}
          </select>
        </div>
        <div class="control">
          <span class="control__label" id="trend-range-label">日期范围</span>
          <div class="segmented" role="group" aria-labelledby="trend-range-label">
            ${rangeButton('7', '最近 7 天')}
            ${rangeButton('30', '最近 30 天')}
            ${rangeButton('all', '全部')}
          </div>
        </div>
        <div class="controls__spacer"></div>
        <button class="btn btn-ghost btn-sm" type="button" data-action="trend-refresh">
          ${icon('refresh', { size: 13, className: 'ico ico--sm' })}重新查询
        </button>
      </div>

      <div class="view" data-trend-output>
        <div class="skeleton skeleton--chart"></div>
        <div class="skeleton skeleton--table"></div>
      </div>
    </div>
  `;
}

export function bind(root, ctx) {
  const modelSelect = root.querySelector('#trend-model');
  const metricSelect = root.querySelector('#trend-metric');
  const concurrencySelect = root.querySelector('#trend-concurrency');

  const apply = (patch) => {
    active = { ...active, ...patch };
    persist(ctx);
    syncUrl(ctx);
    load(root, ctx);
  };

  if (modelSelect) modelSelect.addEventListener('change', () => apply({ model: modelSelect.value }));
  if (metricSelect) metricSelect.addEventListener('change', () => apply({ metric: metricSelect.value }));
  if (concurrencySelect) concurrencySelect.addEventListener('change', () => apply({ concurrency: concurrencySelect.value }));

  root.addEventListener('click', (event) => {
    const rangeButton = event.target.closest('[data-trend-range]');
    if (rangeButton) {
      event.preventDefault();
      const value = rangeButton.dataset.trendRange;
      Array.prototype.forEach.call(root.querySelectorAll('[data-trend-range]'), (button) => {
        const isActive = button.dataset.trendRange === value;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
      });
      active = { ...active, range: value };
      persist(ctx);
      const points = cache.get(cacheKey());
      if (points) {
        paint(root, ctx, points);
      } else {
        load(root, ctx);
      }
      return;
    }

    const retry = event.target.closest('[data-action="trend-retry"]');
    if (retry) {
      event.preventDefault();
      cache.delete(cacheKey());
      load(root, ctx);
      return;
    }

    const refresh = event.target.closest('[data-action="trend-refresh"]');
    if (refresh) {
      event.preventDefault();
      cache.delete(cacheKey());
      load(root, ctx);
    }
  });
}

export function mount(root, ctx) {
  persist(ctx);
  syncUrl(ctx);
  load(root, ctx);
}
