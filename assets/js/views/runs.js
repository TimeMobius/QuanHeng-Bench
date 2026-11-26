// ---------------------------------------------------------------------------
// views/runs.js — 运行记录：手动触发/取消、自动刷新开关、总体与每模型进度、run_log 表
// ---------------------------------------------------------------------------

import { html, raw, setHtml } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { fmtDateTime, fmtDuration, fmtInt, fmtPct } from '../format.js';
import { renderTable } from '../components/data-table.js';
import { emptyState } from '../components/skeleton.js';
import { runStatusBadge, bindTableScrollHints, viewHead } from '../components/ui.js';

const STATUS_LABEL = { pending: '等待', running: '运行中', done: '完成', error: '失败' };

function modelStatusIcon(status) {
  if (status === 'done') return html`<span class="is-good">${icon('check', { size: 12, className: 'ico ico--sm' })}</span>`;
  if (status === 'running') return html`<span class="spinner" aria-hidden="true"></span>`;
  if (status === 'error') return html`<span class="is-bad">${icon('alert', { size: 12, className: 'ico ico--sm' })}</span>`;
  return html`<span class="status-dot" aria-hidden="true"></span>`;
}

function progressPanel(status) {
  if (!status || !status.running) return raw('');
  const percent = Math.round(Math.max(0, Math.min(1, status.progress || 0)) * 100);
  const models = Array.isArray(status.models) ? status.models : [];

  return html`
    <section class="card" data-run-progress-card>
      <div class="card__head">
        <div class="card__titles">
          <h2 class="card__title">运行进度</h2>
          <p class="card__sub">${status.cancel_requested ? '已请求取消，当前批次结束后停止' : '每 2 秒自动刷新（可在上方关闭）'}</p>
        </div>
        <div class="card__actions">
          <button class="btn btn-danger btn-sm" type="button" data-action="cancel-run">取消运行</button>
        </div>
      </div>
      <div class="runs-progress">
        <div class="run-overall">
          <div class="run-overall__top">
            <span class="pill pill--running">运行中</span>
            <span class="text-muted">${status.message || '正在运行测试…'}</span>
            <span class="run-overall__pct" data-overall-pct>${percent}%</span>
          </div>
          <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"
               aria-label="总体进度">
            <span class="progress__bar" data-overall-bar style="width:${percent}%"></span>
          </div>
          <span class="hint" data-overall-meta>
            已完成 ${fmtInt(status.completed_requests)} / ${fmtInt(status.total_requests)} 请求
            · 已用 ${fmtDuration(status.elapsed_secs)}
          </span>
        </div>

        ${models.length
          ? html`<div class="run-models">
              ${models.map((model) => {
                const total = Number(model.total) || 0;
                const completed = Math.min(Number(model.completed) || 0, total || Number(model.completed) || 0);
                const pct = total > 0 ? Math.round((completed / total) * 100) : (model.status === 'done' ? 100 : 0);
                return html`
                  <div class="run-model" data-run-model="${model.name}">
                    <div class="run-model__top">
                      <span class="run-model__status" data-model-status-icon>${modelStatusIcon(model.status)}</span>
                      <span class="run-model__name" title="${model.name}">${model.name}</span>
                      <span class="run-model__meta" data-model-meta>${STATUS_LABEL[model.status] || model.status}</span>
                    </div>
                    <div class="progress progress--sm">
                      <span class="progress__bar" data-model-bar style="width:${pct}%"></span>
                    </div>
                    <span class="hint" data-model-meta-count>${fmtInt(completed)} / ${fmtInt(total)} 请求</span>
                  </div>
                `;
              })}
            </div>`
          : html`<p class="hint">等待后端返回模型进度…</p>`}
      </div>
    </section>
  `;
}

function modeLabel(mode) {
  if (mode === 'model') return '单模型';
  if (mode === 'full') return '全量';
  return mode || '—';
}

function runRows(ctx) {
  const state = ctx.state;
  const fromApi = Array.isArray(state.runLog) ? state.runLog : [];
  if (fromApi.length) return fromApi;
  const dashboard = state.dashboard;
  return dashboard && Array.isArray(dashboard.run_log) ? dashboard.run_log : [];
}

function runTable(ctx) {
  const rows = runRows(ctx).slice();
  return renderTable({
    columns: [
      {
        key: 'status',
        label: '状态',
        align: 'left',
        render: (row) => runStatusBadge(row.status),
        cellTitle: (row) => row.message || '',
      },
      {
        key: 'mode',
        label: '模式',
        align: 'left',
        render: (row) => html`<span class="badge badge--outline">${modeLabel(row.mode)}</span>`,
      },
      {
        key: 'target',
        label: '目标',
        align: 'left',
        render: (row) => (row.target ? html`<span class="mono">${row.target}</span>` : html`<span class="text-muted">全部模型</span>`),
      },
      {
        key: 'started_at',
        label: '开始',
        render: (row) => fmtDateTime(row.started_at),
        cellTitle: (row) => row.started_at || '',
      },
      {
        key: 'duration_secs',
        label: '耗时',
        render: (row) => fmtDuration(row.duration_secs),
      },
      {
        key: 'record_count',
        label: '记录数',
        render: (row) => fmtInt(row.record_count),
      },
      {
        key: 'message',
        label: '消息',
        align: 'left',
        render: (row) => html`<span class="run-message">${row.message || '—'}</span>`,
        cellTitle: (row) => row.message || '',
      },
    ],
    rows,
    ariaLabel: '运行记录列表',
    emptyText: '还没有运行记录。点击「运行测试」开始第一次测试。',
  });
}

function updatedText(ctx) {
  const state = ctx.state;
  if (state.runLogUpdatedAt) return `更新于 ${new Date(state.runLogUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  if (state.updatedAt) return `数据更新于 ${new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  return '';
}

export function render(ctx) {
  const state = ctx.state;
  if (!state.dashboard) return html`<div class="view"></div>`;

  const status = state.status || state.dashboard.status || {};
  const running = Boolean(status.running);
  const autoRefresh = state.autoRefresh !== false;
  const rows = runRows(ctx);

  return html`
    <div class="view" data-view="runs">
      ${viewHead({
        title: html`运行记录`,
        badge: running ? html`<span class="pill pill--running">运行中</span>` : raw(''),
        sub: [
          '手动触发全量 / 单模型测试，或取消正在运行的任务',
          state.dashboard.today ? `今天 ${state.dashboard.today}` : '',
        ].filter(Boolean),
        actions: [
          html`<button class="btn btn-primary" type="button" data-action="run-test"${running ? raw(' disabled') : raw('')}>
            ${icon('play', { size: 14 })}运行测试</button>`,
          html`<button class="btn btn-danger" type="button" data-action="cancel-run"${running ? raw('') : raw(' hidden')}>
            ${icon('stop', { size: 14 })}取消</button>`,
        ],
      })}

      <div class="controls">
        <label class="switch">
          <input type="checkbox" id="auto-refresh"${autoRefresh ? raw(' checked') : raw('')}>
          <span class="switch__track" aria-hidden="true"></span>
          <span class="switch__label">自动刷新（运行中每 2 秒轮询，完成后自动重载数据）</span>
        </label>
        <div class="controls__spacer"></div>
        <span class="hint" data-run-updated>${updatedText(ctx)}</span>
        <button class="btn btn-outline btn-sm" type="button" data-action="runs-refresh">
          ${icon('refresh', { size: 13, className: 'ico ico--sm' })}立即刷新
        </button>
      </div>

      <div data-run-progress>${progressPanel(status)}</div>

      <section class="card">
        <div class="card__head">
          <div class="card__titles">
            <h2 class="card__title">运行日志</h2>
            <p class="card__sub">最近 20 条 · 来源 /api/run-log</p>
          </div>
          <div class="card__actions">
            <span class="hint" data-run-count>${rows.length ? `共 ${fmtInt(rows.length)} 条` : '暂无记录'}</span>
          </div>
        </div>
        <div class="card__body card__body--flush" data-run-table>${runTable(ctx)}</div>
      </section>
    </div>
  `;
}

async function loadRunLog(root, ctx) {
  try {
    const list = await api.runLog(20);
    if (!root.isConnected) return;
    if (typeof ctx.setRunLog === 'function') ctx.setRunLog(list || []);
    const host = root.querySelector('[data-run-table]');
    if (host) {
      setHtml(host, runTable(ctx));
      bindTableScrollHints(root);
    }
    const count = root.querySelector('[data-run-count]');
    if (count) count.textContent = list && list.length ? `共 ${fmtInt(list.length)} 条` : '暂无记录';
    const updated = root.querySelector('[data-run-updated]');
    if (updated) {
      updated.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    }
  } catch (err) {
    if (!root.isConnected) return;
    ctx.notifyError(err, { title: '运行日志加载失败' });
  }
}

export function bind(root, ctx) {
  bindTableScrollHints(root);
  const toggle = root.querySelector('#auto-refresh');
  if (toggle) {
    toggle.addEventListener('change', () => {
      if (typeof ctx.setAutoRefresh === 'function') ctx.setAutoRefresh(toggle.checked);
    });
  }

  root.addEventListener('click', (event) => {
    const refresh = event.target.closest('[data-action="runs-refresh"]');
    if (!refresh) return;
    event.preventDefault();
    loadRunLog(root, ctx);
    if (typeof ctx.reload === 'function') ctx.reload({ keepScroll: true });
  });
}

export function mount(root, ctx) {
  loadRunLog(root, ctx);
}

export function updateStatus(root, status) {
  const host = root.querySelector('[data-run-progress]');
  if (host) {
    setHtml(host, progressPanel(status));
  }
}
