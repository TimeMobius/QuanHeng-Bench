// ---------------------------------------------------------------------------
// components/skeleton.js — 三态之一：加载骨架 / 空状态 / 错误状态
// ---------------------------------------------------------------------------

import { html, raw } from '../dom.js';
import { icon } from '../icons.js';

export function skeletonBlock(className) {
  return html`<div class="skeleton ${className}"></div>`;
}

export function skeletonKpis(count = 7) {
  return html`<div class="kpi-grid">${Array.from({ length: count }, () => html`<div class="skeleton skeleton--kpi"></div>`)}</div>`;
}

export function skeletonChart(heightClass = '') {
  return html`<div class="skeleton skeleton--chart ${heightClass}"></div>`;
}

export function skeletonTable(rows = 6) {
  return html`<div class="card"><div class="card__body" style="display:flex;flex-direction:column;gap:8px">
    ${Array.from({ length: rows }, () => html`<div class="skeleton skeleton--row"></div>`)}
  </div></div>`;
}

export function skeletonView({ kpis = 7, charts = 1, table = true } = {}) {
  return html`
    <div class="view">
      ${skeletonBlock('skeleton--title')}
      ${kpis ? skeletonKpis(kpis) : raw('')}
      ${Array.from({ length: charts }, () => skeletonChart())}
      ${table ? skeletonTable() : raw('')}
    </div>
  `;
}

export function emptyState(options = {}) {
  const {
    iconName = 'database',
    title = '暂无数据',
    text = '',
    actions = [],
    inline = false,
  } = options;
  return html`
    <div class="empty${inline ? ' empty--inline' : ''}">
      <div class="empty__icon">${icon(iconName, { size: 22, className: '' })}</div>
      <p class="empty__title">${title}</p>
      ${text ? html`<p class="empty__text">${text}</p>` : raw('')}
      ${actions.length
        ? html`<div class="empty__actions">
            ${actions.map((action) => html`<button class="btn ${action.kind === 'primary' ? 'btn-primary' : 'btn-outline'}"
              type="button" data-action="${action.action}">${action.label}</button>`)}
          </div>`
        : raw('')}
    </div>
  `;
}

export function errorState(options = {}) {
  const {
    title = '加载失败',
    text = '',
    retryLabel = '重试',
    retryAction = 'retry',
  } = options;
  return html`
    <div class="error-state" role="alert">
      <p class="error-state__title">${icon('alert', { size: 16 })}${title}</p>
      ${text ? html`<p class="error-state__text">${text}</p>` : raw('')}
      <button class="btn btn-outline btn-sm" type="button" data-action="${retryAction}">${retryLabel}</button>
    </div>
  `;
}
