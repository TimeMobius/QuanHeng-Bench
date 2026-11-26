// ---------------------------------------------------------------------------
// components/chart-card.js — 图表卡片：标题 / 说明 / canvas（role=img）/ 导出 PNG
// ---------------------------------------------------------------------------

import { html, raw } from '../dom.js';
import { icon } from '../icons.js';

export function chartCard(options = {}) {
  const {
    id,
    title,
    subtitle = '',
    ariaLabel = '',
    wide = false,
    empty = false,
    emptyText = '暂无可绘制的数据',
    filename = '',
  } = options;

  const exportAttrs = raw([
    'data-action="chart-png"',
    `data-chart="${id}"`,
    filename ? `data-filename="${filename}"` : '',
    empty ? 'disabled' : '',
  ].filter(Boolean).join(' '));

  return html`
    <figure class="card chart-card${wide ? ' chart-card--wide' : ''}" data-chart-card="${id}">
      <figcaption class="card__head">
        <div class="card__titles">
          <span class="card__title">${title}</span>
          ${subtitle ? html`<span class="card__sub">${subtitle}</span>` : raw('')}
        </div>
        <div class="chart-actions">
          <button class="btn btn-ghost btn-sm" type="button" ${exportAttrs}>
            ${icon('download', { size: 13, className: 'ico ico--sm' })}导出 PNG
          </button>
        </div>
      </figcaption>
      <div class="card__body card__body--chart">
        ${empty
          ? html`<div class="chart-box"><p class="chart-empty">${emptyText}</p></div>`
          : html`<div class="chart-box" role="img" aria-label="${ariaLabel || title}">
              <canvas id="chart-${id}"></canvas>
            </div>`}
      </div>
    </figure>
  `;
}
