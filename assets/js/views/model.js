// ---------------------------------------------------------------------------
// views/model.js — 模型详情：可排序明细表（min/max、错误、成功率条）+ 4 张图 + CSV
// ---------------------------------------------------------------------------

import { html, raw, setHtml } from '../dom.js';
import { icon } from '../icons.js';
import {
  fmtDateLabel, fmtDateTime, fmtDuration, fmtFixed, fmtInt, fmtMsExact, fmtPct, fmtClock,
  msParts, tokenParts, fmtConcurrency, statusInfo,
} from '../format.js';
import {
  mountChart, ttftPreset, throughputPreset, successPreset, compositePreset, ttftUsesLogAxis,
} from '../charts.js';
import { chartCard } from '../components/chart-card.js';
import { renderTable, bindTableSort, nextSort } from '../components/data-table.js';
import { emptyState } from '../components/skeleton.js';
import {
  bindModelAvatars, bindTableScrollHints, errorCell, minMaxText, msValue, rateBar, statChip,
  statusBadge, tokenValue, tokenSourceBadge, tokenCoordinate, tpsValue, viewHead, modelAvatar,
} from '../components/ui.js';

let sort = { key: 'concurrency', dir: 'asc' };
let current = null;

function columns() {
  return [
    {
      key: 'concurrency',
      label: '并发',
      align: 'left',
      sortable: true,
      sortDefault: 'asc',
      render: (record) => html`<strong>${fmtConcurrency(record.concurrency)}</strong>`,
    },
    {
      key: 'request_count',
      label: '请求',
      sortable: true,
      sortDefault: 'desc',
      render: (record) => fmtInt(record.request_count),
      sub: (record) => fmtDuration(record.total_duration_secs),
      cellTitle: (record) => `共 ${fmtInt(record.request_count)} 请求 · 耗时 ${fmtDuration(record.total_duration_secs)}`,
    },
    {
      key: 'error_count',
      label: '错误',
      sortable: true,
      sortDefault: 'desc',
      render: (record) => errorCell(record),
    },
    {
      key: 'avg_ttft_ms',
      label: 'TTFT',
      sortable: true,
      sortDefault: 'asc',
      render: (record) => msValue(record.avg_ttft_ms, 'ttft'),
      sub: (record) => minMaxText(record),
      cellTitle: (record) => `平均 ${fmtMsExact(record.avg_ttft_ms)} · 最小 ${fmtMsExact(record.min_ttft_ms)} · 最大 ${fmtMsExact(record.max_ttft_ms)}`,
    },
    {
      key: 'p50_ttft_ms',
      label: 'P50',
      sortable: true,
      sortDefault: 'asc',
      render: (record) => msValue(record.p50_ttft_ms),
      cellTitle: (record) => `P50 ${fmtMsExact(record.p50_ttft_ms)}`,
    },
    {
      key: 'p95_ttft_ms',
      label: 'P95',
      sortable: true,
      sortDefault: 'asc',
      render: (record) => msValue(record.p95_ttft_ms, 'is-warn'),
      cellTitle: (record) => `P95 ${fmtMsExact(record.p95_ttft_ms)}`,
    },
    {
      key: 'p99_ttft_ms',
      label: 'P99',
      sortable: true,
      sortDefault: 'asc',
      render: (record) => msValue(record.p99_ttft_ms, 'is-bad'),
      cellTitle: (record) => `P99 ${fmtMsExact(record.p99_ttft_ms)}`,
    },
    {
      key: 'avg_output_speed_tps',
      label: '输出速度',
      sortable: true,
      sortDefault: 'desc',
      render: (record) => tpsValue(record.avg_output_speed_tps, 'is-good'),
    },
    {
      key: 'avg_tps',
      label: '吞吐',
      sortable: true,
      sortDefault: 'desc',
      render: (record) => tpsValue(record.avg_tps),
    },
    {
      key: 'total_tokens',
      label: 'Token',
      sortable: true,
      sortDefault: 'desc',
      render: (record) => html`<span class="token-cell">${tokenValue(record.total_tokens)}${tokenSourceBadge(record)}</span>`,
      cellTitle: (record) => `${fmtInt(record.total_tokens)} tokens\n${tokenCoordinate(record)}`,
    },
    {
      key: 'success_rate',
      label: '成功率',
      sortable: true,
      sortDefault: 'desc',
      render: (record) => rateBar(record.success_rate),
      cellTitle: (record) => `成功率 ${fmtPct(record.success_rate, 2)}`,
    },
  ];
}

function table(ctx) {
  const records = current ? current.records : [];
  return renderTable({
    columns: columns(),
    rows: records,
    sort,
    ariaLabel: `${current ? current.model.id : ''} 各并发指标`,
    emptyText: '该日期暂无此模型的测试记录',
  });
}

function summaryChips(model) {
  const summary = model.summary || {};
  const hasData = Boolean(model.has_data);
  const pick = (key) => (hasData && Number.isFinite(summary[key]) ? summary[key] : null);
  const ttft = msParts(pick('avg_ttft_ms'));
  const p95 = msParts(pick('p95_ttft_ms'));
  const tokens = tokenParts(pick('tokens'));
  const success = pick('success_rate');
  const outputSpeed = pick('avg_output_speed_tps');
  const overallTps = pick('avg_tps');
  return html`
    <div class="chips">
      ${statChip('平均 TTFT', ttft.value, ttft.unit, hasData)}
      ${statChip('P95', p95.value, p95.unit)}
      ${statChip('输出速度', outputSpeed === null ? '—' : fmtFixed(outputSpeed, 1), outputSpeed === null ? '' : 't/s')}
      ${statChip('整体吞吐', overallTps === null ? '—' : fmtFixed(overallTps, 1), overallTps === null ? '' : 't/s')}
      ${statChip('成功率', success === null ? '—' : fmtPct(success))}
      ${statChip('请求数', hasData ? fmtInt(summary.requests) : '—')}
      ${statChip('Token', tokens.value, tokens.unit)}
      ${statChip('总耗时', hasData ? fmtDuration(summary.duration_secs) : '—')}
      ${statChip('最大并发', hasData && Number.isFinite(summary.max_concurrency) ? fmtConcurrency(summary.max_concurrency) : '—')}
    </div>
  `;
}

function charts(ctx, model, records, date) {
  const hasData = records.length > 0;
  const logAxis = hasData && ttftUsesLogAxis(records);
  return html`
    <div class="chart-grid">
      ${chartCard({
        id: 'model-ttft',
        title: 'TTFT 与延迟分位',
        subtitle: `平均 / P50 / P95 / P99 · 单位 ms${logAxis ? ' · 跨度大，Y 轴取对数' : ''}`,
        ariaLabel: `${model.id} 的平均 TTFT 与 P50/P95/P99 随并发变化折线图`,
        filename: `${model.id}-ttft-${date}.png`,
        empty: !hasData,
      })}
      ${chartCard({
        id: 'model-throughput',
        title: '吞吐量（双 Y 轴）',
        subtitle: '左轴输出速度 · 右轴整体吞吐 · 单位 t/s',
        ariaLabel: `${model.id} 的输出速度与整体吞吐双轴折线图`,
        filename: `${model.id}-throughput-${date}.png`,
        empty: !hasData,
      })}
      ${chartCard({
        id: 'model-success',
        title: '成功率',
        subtitle: '0–100% · 越接近 100 越稳定',
        ariaLabel: `${model.id} 各并发成功率折线图`,
        filename: `${model.id}-success-${date}.png`,
        empty: !hasData,
      })}
      ${chartCard({
        id: 'model-composite',
        title: '综合对比',
        subtitle: 'TTFT 左轴（ms）· 吞吐右轴（t/s）',
        ariaLabel: `${model.id} 各并发 TTFT 与吞吐综合柱状图`,
        filename: `${model.id}-composite-${date}.png`,
        empty: !hasData,
      })}
    </div>
  `;
}

export function render(ctx) {
  const state = ctx.state;
  const dashboard = state.dashboard;
  if (!dashboard) return html`<div class="view"></div>`;

  const models = dashboard.models || [];
  const requested = ctx.route.id || state.lastModel || '';
  const model = models.find((item) => item.id === requested)
    || models.find((item) => item.has_data)
    || models[0];

  if (!model) {
    return html`
      <div class="view">
        ${emptyState({
          iconName: 'layers',
          title: '未找到模型',
          text: '当前日期没有可展示的模型数据。',
          actions: [{ label: '返回概览', action: 'go-overview', kind: 'primary' }],
        })}
      </div>
    `;
  }

  const date = ctx.route.date || dashboard.date || state.date || state.today;
  const records = (model.records || []).slice().sort((a, b) => a.concurrency - b.concurrency);
  const summary = model.summary || {};
  const hasData = records.length > 0;
  const info = statusInfo(model.status);
  const lastUpdated = records.reduce((acc, record) => {
    const stamp = record.created_at_local || record.created_at || '';
    return stamp > acc ? stamp : acc;
  }, '');

  current = { model, records, date };

  return html`
    <div class="view" data-view="model">
      ${viewHead({
        back: { href: '#/overview', label: html`${icon('arrowLeft', { size: 13, className: 'ico ico--sm' })}返回概览` },
        title: html`<span class="cell-model" style="gap:9px">${modelAvatar(model, { large: true })}<span>${model.id}</span></span>`,
        badge: html`<span class="badge badge--${info.tone === 'none' ? 'outline' : info.tone}">${info.label}</span>`,
        sub: [
          html`${fmtDateLabel(date)}`,
          hasData ? html`${fmtInt(records.length)} 个并发级别` : html`暂无测试记录`,
          Number.isFinite(summary.requests) ? html`共 ${fmtInt(summary.requests)} 请求` : '',
          lastUpdated ? html`更新于 ${fmtDateTime(lastUpdated)}` : '',
        ].filter(Boolean),
        actions: [
          html`<button class="btn btn-primary" type="button" data-action="run-model" data-model="${model.id}">
            ${icon('refresh', { size: 14 })}重新测试此模型</button>`,
          html`<button class="btn btn-outline" type="button" data-action="add-compare" data-model="${model.id}">
            ${icon('compare', { size: 14 })}加入对比</button>`,
          html`<a class="btn btn-outline" href="${ctx.exportUrl(model.id)}">${icon('download', { size: 14 })}导出 CSV</a>`,
        ],
      })}

      ${summaryChips(model)}

      ${hasData
        ? html`
            <section class="card">
              <div class="card__head">
                <div class="card__titles">
                  <h2 class="card__title">各并发明细</h2>
                  <p class="card__sub">点击表头排序 · 悬停行查看 min / max 与错误摘要</p>
                </div>
                <div class="card__actions">
                  <span class="hint">${records.length} 行</span>
                </div>
              </div>
              <div class="card__body card__body--flush" data-model-table>
                ${table(ctx)}
              </div>
            </section>
            ${charts(ctx, model, records, date)}
          `
        : html`
            <section class="card">
              ${emptyState({
                iconName: 'activity',
                title: '该模型在所选日期暂无数据',
                text: '可以单独重测此模型，或切换到有数据的日期。',
                actions: [
                  { label: '重新测试此模型', action: 'run-model', kind: 'primary' },
                  { label: '返回概览', action: 'go-overview' },
                ],
              })}
            </section>
          `}
    </div>
  `;
}

export function bind(root, ctx) {
  bindModelAvatars(root);
  bindTableScrollHints(root);
  bindTableSort(root, (key) => {
    sort = nextSort(sort, key, columns());
    const host = root.querySelector('[data-model-table]');
    if (host) {
      setHtml(host, table(ctx));
      bindTableScrollHints(root);
    }
  });
}

export function mount(root, ctx) {
  if (!current) return;
  const { model, records } = current;
  if (typeof ctx.rememberModel === 'function') ctx.rememberModel(model.id);
  if (!records.length) return;

  mountChart('model-ttft', (theme) => ttftPreset(records, theme));
  mountChart('model-throughput', (theme) => throughputPreset(records, theme));
  mountChart('model-success', (theme) => successPreset(records, theme));
  mountChart('model-composite', (theme) => compositePreset(records, theme));
}

/** 供外部（如“运行记录”里的单模型重测）读取当前模型 */
export function currentModelId() {
  return current ? current.model.id : '';
}
