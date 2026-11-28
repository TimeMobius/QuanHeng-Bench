// ---------------------------------------------------------------------------
// views/overview.js — 概览：KPI、今日最佳、模型状态表、各模型 TTFT 柱状图、运行状态
// ---------------------------------------------------------------------------

import { html, raw, setHtml, bindActions } from '../dom.js';
import { icon } from '../icons.js';
import {
  fmtDateLabel, fmtDateTime, fmtDuration, fmtInt, fmtMs, fmtPct, fmtTps,
  msParts, tokenParts, runStatusInfo, fmtConcurrency, fmtFixed,
} from '../format.js';
import { renderTable, bindTableSort, bindRowLinks, nextSort } from '../components/data-table.js';
import { emptyState } from '../components/skeleton.js';
import {
  bindModelAvatars, bindTableScrollHints, kpiCard, modelAvatar, protocolBadge, rateBar,
  statusBadge, statusDot, viewHead, msValue, tpsValue, tokenValue,
} from '../components/ui.js';

const TONES = ['', 'is-warn', 'is-bad'];

let sort = { key: 'avg_ttft', dir: 'asc' };
let latest = { dashboard: null, date: '' };
let currentLevel = null;

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

/**
 * 并发档位选择。
 *
 * 概览页此前用「全档位按请求数加权」的汇总值，那是**没有物理意义的数字**：
 * 把 1 并发和 128 并发的延迟平均起来，既不代表轻载也不代表满载。
 *
 * 现在由用户明确选一个并发档，页面上所有指标都取该档的真实测量值，
 * 每个数字都能对应到"在这个并发下测得"这样一个确定的条件。
 */
function levelOf(ctx) {
  const params = (ctx.route && ctx.route.params) || null;
  const raw = params ? Number(params.get('c')) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** 当天数据里出现过的并发档位（升序）。 */
function availableLevels(models) {
  const set = new Set();
  models.forEach((model) => (model.records || []).forEach((r) => {
    if (Number(r.concurrency) > 0 && Number(r.request_count) > 0) set.add(Number(r.concurrency));
  }));
  return [...set].sort((a, b) => a - b);
}

/** 未指定档位时的默认值：取中位数档，尽量避开极端（1 并发与最大并发都不具代表性）。 */
function defaultLevel(levels) {
  if (!levels.length) return null;
  return levels[Math.floor((levels.length - 1) / 2)];
}

/** 取某模型在指定档位的记录。 */
function recordAt(model, level) {
  return (model.records || []).find((r) => Number(r.concurrency) === level) || null;
}

/**
 * 按所选档位对一组模型的记录做聚合。
 *
 * 同一档位下加权是按请求数（各模型同一档的请求数可能不同），
 * 但此时所有样本都来自同一并发——这是有意义的加权。
 */
function summarizeAtLevel(models, level) {
  const rows = models
    .map((model) => ({ model, record: recordAt(model, level) }))
    .filter((x) => x.record && Number(x.record.request_count) > 0);
  if (!rows.length) return null;

  const reqs = rows.reduce((a, x) => a + Number(x.record.request_count), 0);
  const errs = rows.reduce((a, x) => a + Number(x.record.error_count || 0), 0);
  const w = (pick) => {
    if (!reqs) return null;
    return rows.reduce((a, x) => a + pick(x.record) * Number(x.record.request_count), 0) / reqs;
  };
  const inputTok = w((r) => Number(r.input_tokens) || 0);
  const ttftSecs = w((r) => Number(r.avg_ttft_ms) / 1000);
  const prefill = (inputTok && ttftSecs) ? inputTok / ttftSecs : null;

  return {
    level,
    models: rows.length,
    requests: reqs,
    errorCount: errs,
    avgTtft: w((r) => Number(r.avg_ttft_ms)),
    p95Ttft: w((r) => Number(r.p95_ttft_ms)),
    prefillTps: prefill,
    decodeTps: w((r) => Number(r.avg_output_speed_tps)),
    overallTps: w((r) => Number(r.avg_tps)),
    successRate: reqs ? ((reqs / (reqs + errs)) * 100) : null,
    tokens: rows.reduce((a, x) => a + Number(x.record.total_tokens || 0), 0),
    duration: rows.reduce((a, x) => a + Number(x.record.total_duration_secs || 0), 0),
  };
}

/** 某一档下每项指标的最优模型。 */
function bestAtLevel(models, level) {
  const entries = models
    .map((model) => ({ model: model.id, record: recordAt(model, level) }))
    .filter((x) => x.record && Number(x.record.request_count) > 0);
  const min = (pick) => {
    let best = null;
    entries.forEach((x) => {
      const v = pick(x.record);
      if (Number.isFinite(v) && v > 0 && (!best || v < best.value)) best = { model: x.model, value: v };
    });
    return best;
  };
  const max = (pick) => {
    let best = null;
    entries.forEach((x) => {
      const v = pick(x.record);
      if (Number.isFinite(v) && v > 0 && (!best || v > best.value)) best = { model: x.model, value: v };
    });
    return best;
  };
  return {
    ttft: min((r) => Number(r.avg_ttft_ms)),
    decode: max((r) => Number(r.avg_output_speed_tps)),
    success: max((r) => Number(r.success_rate)),
  };
}

/** 并发档位选择器（写入 hash 的 c 参数，可分享/刷新保持）。 */
function levelPicker(ctx, levels, active) {
  if (levels.length < 2) return raw('');
  return html`
    <div class="level-picker" role="group" aria-label="选择并发档位">
      <span class="level-picker__label">并发</span>
      ${levels.map((level) => html`
        <a class="level-chip${level === active ? ' is-active' : ''}"
           href="#/overview?date=${encodeURIComponent(viewDate(ctx))}&c=${level}"
           aria-current="${level === active ? 'true' : 'false'}">${fmtConcurrency(level)}</a>
      `)}
    </div>
  `;
}

function kpiRow(ctx) {
  const dashboard = ctx.state.dashboard;
  const models = dashboard.models || [];
  const level = currentLevel;
  const agg = level === null ? null : summarizeAtLevel(models, level);
  const best = level === null ? { ttft: null, decode: null, success: null } : bestAtLevel(models, level);
  const date = viewDate(ctx);
  const tested = models.filter((model) => model.has_data);

  const ttft = msParts(agg ? agg.avgTtft : null);
  const prefill = agg ? agg.prefillTps : null;
  const decode = agg ? agg.decodeTps : null;
  const success = agg ? agg.successRate : null;
  const tokens = tokenParts(agg ? agg.tokens : null);

  const bestLink = (entry, fmt) => (entry
    ? html`最佳 <a href="#/model/${encodeURIComponent(entry.model)}?date=${encodeURIComponent(date)}">${entry.model}</a> ${fmt(entry.value)}`
    : '该档暂无数据');

  return html`
    <div class="kpi-grid">
      ${kpiCard({
        label: '有数据模型',
        value: fmtInt(agg ? agg.models : 0),
        hint: html`共 ${fmtInt(models.length)} 个 · 本档 ${fmtInt(tested.length)} 个可测`,
      })}
      ${kpiCard({
        label: '请求数',
        value: agg ? fmtInt(agg.requests) : '—',
        hint: agg
          ? (agg.errorCount
            ? html`<span class="is-bad">${fmtInt(agg.errorCount)} 个失败</span>`
            : '全部成功')
          : '该档暂无请求',
      })}
      ${kpiCard({
        label: '平均 TTFT',
        value: ttft.value,
        unit: ttft.unit,
        accent: Boolean(agg),
        hint: bestLink(best.ttft, (v) => fmtMs(v)),
      })}
      ${kpiCard({
        label: 'Prefill 吞吐',
        value: prefill === null ? '—' : fmtFixed(prefill, 1),
        unit: prefill === null ? '' : 't/s',
        hint: prefill === null ? '本档无输入 token 数（protocol v1）' : '输入 token ÷ TTFT · 含排队与网络',
      })}
      ${kpiCard({
        label: 'Decode 吞吐',
        value: decode === null ? '—' : fmtFixed(decode, 1),
        unit: decode === null ? '' : 't/s',
        hint: bestLink(best.decode, (v) => fmtTps(v)),
      })}
      ${kpiCard({
        label: '成功率',
        value: success === null ? '—' : fmtFixed(success, 1),
        unit: success === null ? '' : '%',
        hint: bestLink(best.success, (v) => fmtPct(v)),
      })}
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
  // 取当前档位的记录；所有数值都来自同一并发，可直接横向比较
  const rec = (model) => (currentLevel === null ? null : recordAt(model, currentLevel));
  const val = (pick) => (model) => {
    const r = rec(model);
    return r ? pick(r) : null;
  };

  return [
    {
      key: 'id',
      label: '模型',
      align: 'left',
      sortValue: (model) => model.id,
      render: (model) => html`<span class="cell-model">${modelAvatar(model)}<span class="cell-model__name">${model.id}</span></span>`,
    },
    {
      key: 'status',
      label: '状态',
      sortValue: (model) => ({ good: 0, warn: 1, bad: 2, none: 3 }[model.status] ?? 4),
      render: (model) => html`<span class="cell-model" style="gap:6px">${statusDot(model.status)}${statusBadge(model.status)}</span>`,
    },
    {
      key: 'avg_ttft',
      label: 'TTFT',
      sortable: true,
      sortDefault: 'asc',
      sortValue: val((r) => Number(r.avg_ttft_ms)),
      render: (model) => { const r = rec(model); return r ? msValue(r.avg_ttft_ms) : html`<span class="text-faint">—</span>`; },
    },
    {
      key: 'prefill',
      label: 'Prefill',
      sortable: true,
      sortDefault: 'desc',
      sortValue: val((r) => (Number(r.input_tokens) > 0 && Number(r.avg_ttft_ms) > 0
        ? Number(r.input_tokens) / (Number(r.avg_ttft_ms) / 1000) : null)),
      render: (model) => {
        const r = rec(model);
        if (!r || !(Number(r.input_tokens) > 0) || !(Number(r.avg_ttft_ms) > 0)) {
          return html`<span class="text-faint">—</span>`;
        }
        return tpsValue(Number(r.input_tokens) / (Number(r.avg_ttft_ms) / 1000));
      },
    },
    {
      key: 'decode',
      label: 'Decode',
      sortable: true,
      sortDefault: 'desc',
      sortValue: val((r) => Number(r.avg_output_speed_tps)),
      render: (model) => { const r = rec(model); return r ? tpsValue(r.avg_output_speed_tps) : html`<span class="text-faint">—</span>`; },
    },
    {
      key: 'success_rate',
      label: '成功率',
      sortable: true,
      sortDefault: 'desc',
      sortValue: val((r) => Number(r.success_rate)),
      render: (model) => { const r = rec(model); return r ? rateBar(r.success_rate) : html`<span class="text-faint">—</span>`; },
    },
    {
      key: 'requests',
      label: '请求数',
      sortable: true,
      sortDefault: 'desc',
      sortValue: val((r) => Number(r.request_count)),
      render: (model) => { const r = rec(model); return r ? fmtInt(r.request_count) : html`<span class="text-faint">—</span>`; },
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

  const config = dashboard.config || {};
  const date = ctx.route.date || dashboard.date || ctx.state.date || ctx.state.today;

  // 并发档位：有 c 参数就用它，否则取中位档（避开 1 与最大这两个极端）
  const levels = availableLevels(models);
  const requested = levelOf(ctx);
  const activeLevel = (requested && levels.includes(requested)) ? requested : defaultLevel(levels);
  currentLevel = activeLevel;

  const tested = models.filter((model) => model.has_data);
  const levelsText = levels.map((l) => fmtConcurrency(l)).join(' / ');
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
          levelsText ? html`共 ${levels.length} 档：${levelsText}` : '',
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

      ${levelPicker(ctx, levels, activeLevel)}

      ${kpiRow(ctx)}

      <section class="card">
        <div class="card__head">
          <div class="card__titles">
            <h2 class="card__title">模型状态 · 并发 ${activeLevel === null ? '—' : fmtConcurrency(activeLevel)}</h2>
            <p class="card__sub">
              所有指标均为该并发档的实测值 · 点击表头排序 · 点击行进入模型详情
            </p>
          </div>
          <div class="card__actions">
            <a class="btn btn-ghost btn-sm" href="#/compare?date=${encodeURIComponent(date)}">多模型对比</a>
          </div>
        </div>
        <div class="card__body card__body--flush" data-model-table>
          ${modelTable(ctx, date)}
        </div>
      </section>
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
  // 概览页不再有图表：柱状图与下方表格表达同样的信息，而表格能精确排序、
  // 可点击进入详情。图留给模型详情（随并发变化）与对比页（多模型曲线）。
  void root;
  void ctx;
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
