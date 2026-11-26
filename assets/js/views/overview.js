// ---------------------------------------------------------------------------
// views/overview.js — 概览：KPI、今日最佳、模型状态表、各模型 TTFT 柱状图、运行状态
// ---------------------------------------------------------------------------

import { html, raw, setHtml, bindActions } from '../dom.js';
import { icon } from '../icons.js';
import {
  fmtDateLabel, fmtDateTime, fmtDuration, fmtInt, fmtMs, fmtPct, fmtTps,
  msParts, tokenParts, runStatusInfo, fmtConcurrency, fmtFixed,
} from '../format.js';
import { mountChart, modelsBarPreset } from '../charts.js';
import { chartCard } from '../components/chart-card.js';
import { renderTable, bindTableSort, bindRowLinks, nextSort } from '../components/data-table.js';
import { emptyState } from '../components/skeleton.js';
import {
  bindModelAvatars, bindTableScrollHints, kpiCard, modelAvatar, protocolBadge, rateBar,
  statusBadge, statusDot, viewHead, msValue, tpsValue, tokenValue,
} from '../components/ui.js';

const TONES = ['', 'is-warn', 'is-bad'];

let sort = { key: 'avg_ttft', dir: 'asc' };
let latest = { dashboard: null, date: '' };

/**
 * Resolve the date this view is showing. Every model link must carry it, or a
 * click from a historical day silently lands on today's data.
 */
function viewDate(ctx) {
  const dashboard = (ctx.state && ctx.state.dashboard) || {};
  return (ctx.route && ctx.route.date) || dashboard.date || ctx.state.date || ctx.state.today;
}

function metricOf(summary, key) {
  return summary && Number.isFinite(summary[key]) ? summary[key] : null;
}

/** 汇总里没有请求数时视为“无数据”，避免把后端的 0 当成 0 ms。 */
function summaryHasData(summary) {
  return Boolean(summary) && Number(summary.requests) > 0;
}

/**
 * 运行状态：status.last_run_status 只在本次进程跑过测试后才有值，
 * 空闲时用 dashboard.run_log[0] 兜底（历史库记录的最后一条运行）。
 */
function lastRunInfo(state) {
  const dashboard = state.dashboard || {};
  const status = state.status || dashboard.status || {};
  const logs = Array.isArray(dashboard.run_log) && dashboard.run_log.length
    ? dashboard.run_log
    : (Array.isArray(state.runLog) ? state.runLog : []);
  const log = logs[0] || null;
  return {
    status,
    running: Boolean(status.running),
    lastStatus: status.last_run_status || (log && log.status) || '',
    lastAt: status.last_run || (log && (log.finished_at || log.started_at)) || '',
    message: (log && log.message) || status.message || '',
    recordCount: log && Number.isFinite(Number(log.record_count)) ? Number(log.record_count) : null,
    modelTarget: log && log.target ? log.target : '',
  };
}

function bestLink(best, key, formatter, date = '') {
  const entry = best && best[key];
  if (!entry || !entry.model) return null;
  return { model: entry.model, value: formatter(entry.value) };
}

function kpiRow(ctx) {
  const dashboard = ctx.state.dashboard;
  const summary = dashboard.summary || {};
  const models = dashboard.models || [];
  const tested = models.filter((model) => model.has_data);
  const best = dashboard.best || {};
  const hasData = summaryHasData(summary);
  const pick = (key) => (hasData ? metricOf(summary, key) : null);

  const ttft = msParts(pick('avg_ttft_ms'));
  const p95 = msParts(pick('p95_ttft_ms'));
  const outputSpeed = pick('avg_output_speed_tps');
  const overallTps = pick('avg_tps');
  const successRate = pick('success_rate');
  const tokens = tokenParts(hasData ? summary.tokens : null);
  const bestTtft = bestLink(best, 'ttft', (value) => fmtMs(value));
  const bestOutput = bestLink(best, 'output_speed', (value) => fmtTps(value));
  const bestSuccess = bestLink(best, 'success_rate', (value) => fmtPct(value));

  return html`
    <div class="kpi-grid">
      ${kpiCard({
        label: '模型数',
        value: fmtInt(models.length),
        hint: html`${fmtInt(tested.length)} 个今日有数据`,
      })}
      ${kpiCard({
        label: '请求数',
        value: fmtInt(summary.requests),
        hint: hasData
          ? (summary.error_count
            ? html`<span class="is-bad">${fmtInt(summary.error_count)} 个失败</span>`
            : '全部成功')
          : '该日期暂无请求',
      })}
      ${kpiCard({
        label: '平均 TTFT',
        value: ttft.value,
        unit: ttft.unit,
        accent: hasData,
        hint: bestTtft
          ? html`最佳 <a href="#/model/${encodeURIComponent(bestTtft.model)}?date=${encodeURIComponent(viewDate(ctx))}">${bestTtft.model}</a>`
          : '暂无数据',
      })}
      ${kpiCard({
        label: 'P95 延迟',
        value: p95.value,
        unit: p95.unit,
        hint: hasData ? '按请求数加权' : '暂无数据',
      })}
      ${kpiCard({
        label: '输出速度',
        value: outputSpeed === null ? '—' : fmtFixed(outputSpeed, 1),
        unit: outputSpeed === null ? '' : 't/s',
        hint: bestOutput
          ? html`最佳 <a href="#/model/${encodeURIComponent(bestOutput.model)}?date=${encodeURIComponent(viewDate(ctx))}">${bestOutput.model}</a>`
          : '暂无数据',
      })}
      ${kpiCard({
        label: '成功率',
        value: successRate === null ? '—' : fmtFixed(successRate, 1),
        unit: successRate === null ? '' : '%',
        hint: bestSuccess
          ? html`最高 <a href="#/model/${encodeURIComponent(bestSuccess.model)}?date=${encodeURIComponent(viewDate(ctx))}">${bestSuccess.model}</a>`
          : '暂无数据',
      })}
      ${kpiCard({
        label: '总 Token',
        value: tokens.value,
        unit: tokens.unit,
        hint: hasData ? `总耗时 ${fmtDuration(summary.duration_secs)}` : '暂无数据',
      })}
    </div>
  `;
}

function bestCard(label, iconName, entry, formatter, unit = '', date = '') {
  if (!entry || !entry.model) {
    return html`
      <div class="best-card best-card--empty">
        <span class="best-card__label">${icon(iconName, { size: 13, className: 'ico ico--sm' })}${label}</span>
        <span class="best-card__value">暂无数据</span>
        <span class="best-card__model">该日期没有成功记录</span>
      </div>
    `;
  }
  return html`
    <div class="best-card">
      <span class="best-card__label">${icon(iconName, { size: 13, className: 'ico ico--sm' })}${label}</span>
      <span class="best-card__value">${formatter(entry.value)}<span class="unit">${unit}</span></span>
      <span class="best-card__model">
        <a href="#/model/${encodeURIComponent(entry.model)}?date=${encodeURIComponent(date)}">${entry.model}</a>
      </span>
    </div>
  `;
}

function bestRow(ctx) {
  const best = (ctx.state.dashboard && ctx.state.dashboard.best) || {};
  const date = viewDate(ctx);
  return html`
    <div class="best-grid">
      ${bestCard('最低平均 TTFT', 'zap', best.ttft, (value) => fmtMs(value), '', date)}
      ${bestCard('最高整体吞吐', 'gauge', best.tps, (value) => fmtTps(value), '', date)}
      ${bestCard('最快输出速度', 'activity', best.output_speed, (value) => fmtTps(value), '', date)}
      ${bestCard('最高成功率', 'trophy', best.success_rate, (value) => fmtPct(value), '', date)}
    </div>
  `;
}

function runBanner(ctx) {
  const run = lastRunInfo(ctx.state);
  const info = runStatusInfo(run.lastStatus);
  const status = run.status;
  const running = run.running;

  if (running) {
    const pct = Math.round(Math.max(0, Math.min(1, status.progress || 0)) * 100);
    return html`
      <div class="run-banner run-banner--running" data-run-banner role="status" aria-live="polite">
        <span class="pill pill--running">运行中</span>
        <div class="run-banner__text">
          <span class="run-banner__title">${status.message || '正在运行测试…'}</span>
          <span class="run-banner__sub" data-status-message>
            已完成 ${fmtInt(status.completed_requests)} / ${fmtInt(status.total_requests)} 请求 · 已用 ${fmtDuration(status.elapsed_secs)}
          </span>
        </div>
        <div class="run-banner__progress">
          <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"
               aria-label="运行进度" data-status-track>
            <span class="progress__bar" data-status-bar style="width:${pct}%"></span>
          </div>
          <span class="text-faint" data-status-pct>${pct}%</span>
        </div>
        <div class="run-banner__actions">
          <button class="btn btn-danger btn-sm" type="button" data-action="cancel-run">取消运行</button>
          <a class="btn btn-outline btn-sm" href="#/runs">运行记录</a>
        </div>
      </div>
    `;
  }

  const tone = info.tone === 'none' ? 'none' : info.tone;
  return html`
    <div class="run-banner" data-run-banner>
      <span class="pill pill--${run.lastStatus ? tone : 'none'}">${run.lastStatus ? info.label : '就绪'}</span>
      <div class="run-banner__text">
        <span class="run-banner__title">${run.lastAt ? `上次运行：${fmtDateTime(run.lastAt)}` : '尚未运行测试'}</span>
        <span class="run-banner__sub">${run.message || '数据来自本地 SQLite 历史记录'}</span>
      </div>
      ${run.recordCount
        ? html`<span class="badge badge--outline">${fmtInt(run.recordCount)} 条记录</span>`
        : raw('')}
      <div class="run-banner__actions">
        <a class="btn btn-outline btn-sm" href="#/runs">运行记录</a>
      </div>
    </div>
  `;
}

function columns() {
  return [
    {
      key: 'id',
      label: '模型',
      align: 'left',
      sortable: true,
      sortDefault: 'asc',
      sortValue: (model) => model.id,
      render: (model) => html`<span class="cell-model">${modelAvatar(model)}<span class="cell-model__name">${model.id}</span></span>`,
    },
    {
      key: 'status',
      label: '状态',
      align: 'left',
      sortable: true,
      sortDefault: 'asc',
      sortValue: (model) => ({ good: 0, warn: 1, bad: 2, none: 3 }[model.status] ?? 4),
      render: (model) => html`<span class="cell-model" style="gap:6px">${statusDot(model.status)}${statusBadge(model.status)}</span>`,
    },
    {
      key: 'avg_ttft',
      label: '平均 TTFT',
      sortable: true,
      sortDefault: 'asc',
      sortValue: (model) => (model.has_data ? metricOf(model.summary, 'avg_ttft_ms') : null),
      render: (model) => (model.has_data ? msValue(metricOf(model.summary, 'avg_ttft_ms')) : html`<span class="text-faint">—</span>`),
      cellTitle: (model) => (model.has_data && Number.isFinite(metricOf(model.summary, 'avg_ttft_ms'))
        ? `TTFT ${fmtMs(metricOf(model.summary, 'avg_ttft_ms'))}`
        : '暂无数据'),
    },
    {
      key: 'output',
      label: '输出速度',
      sortable: true,
      sortDefault: 'desc',
      sortValue: (model) => (model.has_data ? metricOf(model.summary, 'avg_output_speed_tps') : null),
      render: (model) => (model.has_data
        ? tpsValue(metricOf(model.summary, 'avg_output_speed_tps'), 'is-good')
        : html`<span class="text-faint">—</span>`),
    },
    {
      key: 'success_rate',
      label: '成功率',
      sortable: true,
      sortDefault: 'desc',
      sortValue: (model) => (model.has_data ? metricOf(model.summary, 'success_rate') : null),
      render: (model) => (model.has_data ? rateBar(metricOf(model.summary, 'success_rate')) : html`<span class="text-faint">—</span>`),
    },
    {
      key: 'requests',
      label: '请求数',
      sortable: true,
      sortDefault: 'desc',
      sortValue: (model) => (model.has_data ? metricOf(model.summary, 'requests') : null),
      render: (model) => (model.has_data ? fmtInt(metricOf(model.summary, 'requests')) : html`<span class="text-faint">—</span>`),
    },
  ];
}

function modelTable(ctx, date) {
  const models = (ctx.state.dashboard.models || []).slice();
  return renderTable({
    columns: columns(),
    rows: models,
    sort,
    ariaLabel: '模型状态与汇总指标',
    emptyText: '暂无模型',
    rowClass: (model) => 'is-clickable',
    rowAttrs: (model) => raw(`data-row-href="#/model/${encodeURIComponent(model.id)}?date=${encodeURIComponent(date)}" tabindex="0"`),
  });
}

export function render(ctx) {
  const dashboard = ctx.state.dashboard;
  if (!dashboard) return html`<div class="view"></div>`;

  const models = dashboard.models || [];
  if (!models.length) {
    return html`
      <div class="view">
        ${emptyState({
          iconName: 'database',
          title: '还没有模型数据',
          text: '后端尚未返回模型列表。可以运行一次测试，或稍后刷新。',
          actions: [
            { label: '运行测试', action: 'run-test', kind: 'primary' },
            { label: '重新加载', action: 'retry' },
          ],
        })}
      </div>
    `;
  }

  const summary = dashboard.summary || {};
  const config = dashboard.config || {};
  const date = ctx.route.date || dashboard.date || ctx.state.date || ctx.state.today;
  const tested = models.filter((model) => model.has_data);
  const levels = (config.concurrency_levels || []).join(' / ');
  const upstream = config.base_url || ctx.state.upstreamBase || '';
  const scheduled = config.scheduled || {};
  const scheduleText = Number.isFinite(scheduled.hour)
    ? `每日 ${String(scheduled.hour).padStart(2, '0')}:${String(scheduled.minute || 0).padStart(2, '0')} 自动测试`
    : '';

  latest = { dashboard, date };

  return html`
    <div class="view" data-view="overview">
      ${viewHead({
        title: html`今日概览`,
        badge: html`<span class="badge badge--outline">${fmtDateLabel(date)}</span>`,
        sub: [
          html`${fmtInt(tested.length)} / ${fmtInt(models.length)} 个模型有数据`,
          levels ? html`并发 ${levels}` : '',
          upstream ? html`接口 ${upstream}` : '',
          scheduleText ? html`${scheduleText}` : '',
          protocolBadge(config),
        ].filter(Boolean),
        actions: [
          html`<button class="btn btn-primary" type="button" data-action="run-test">${icon('play', { size: 14 })}运行全部模型</button>`,
          html`<a class="btn btn-outline" href="${ctx.exportUrl(null)}">${icon('download', { size: 14 })}导出当日 CSV</a>`,
        ],
      })}

      ${runBanner(ctx)}

      ${kpiRow(ctx)}

      ${bestRow(ctx)}

      <div class="overview-grid">
        <section class="card">
          <div class="card__head">
            <div class="card__titles">
              <h2 class="card__title">模型状态</h2>
              <p class="card__sub">点击表头排序 · 点击行进入模型详情</p>
            </div>
            <div class="card__actions">
              <a class="btn btn-ghost btn-sm" href="#/compare?date=${encodeURIComponent(date)}">多模型对比</a>
            </div>
          </div>
          <div class="card__body card__body--flush" data-model-table>
            ${modelTable(ctx, date)}
          </div>
        </section>

        <div data-overview-chart>
          ${chartCard({
            id: 'overview-ttft',
            title: '各模型平均 TTFT',
            subtitle: '横条越短越好 · 按状态着色',
            ariaLabel: '各模型平均 TTFT 横向柱状图',
            filename: `models-ttft-${date}.png`,
            empty: !tested.length,
            emptyText: '暂无模型数据',
          })}
        </div>
      </div>
    </div>
  `;
}

function refreshTable(root, ctx) {
  const host = root.querySelector('[data-model-table]');
  if (!host) return;
  setHtml(host, modelTable(ctx, viewDate(ctx)));
}

export function bind(root, ctx) {
  bindModelAvatars(root);
  bindRowLinks(root);
  bindTableScrollHints(root);
  bindTableSort(root, (key) => {
    sort = nextSort(sort, key, columns());
    refreshTable(root, ctx);
    bindTableScrollHints(root);
  });
}

export function mount(root, ctx) {
  const tested = (ctx.state.dashboard.models || []).filter((model) => model.has_data);
  if (!tested.length) return;
  mountChart('overview-ttft', (theme) => modelsBarPreset(ctx.state.dashboard.models || [], theme));
}

export function updateStatus(root, status) {
  if (!status || !status.running) return;
  const banner = root.querySelector('[data-run-banner]');
  if (!banner) return;
  const pct = Math.round(Math.max(0, Math.min(1, status.progress || 0)) * 100);
  const bar = banner.querySelector('[data-status-bar]');
  const pctEl = banner.querySelector('[data-status-pct]');
  const message = banner.querySelector('[data-status-message]');
  if (bar) bar.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (message) {
    message.textContent = `已完成 ${fmtInt(status.completed_requests)} / ${fmtInt(status.total_requests)} 请求 · 已用 ${fmtDuration(status.elapsed_secs)}`;
  }
}
