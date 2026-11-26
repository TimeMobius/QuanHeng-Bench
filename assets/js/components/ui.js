// ---------------------------------------------------------------------------
// components/ui.js — 视图共用的小片段（模型头像、成功率条、状态徽章、数值单元）
// ---------------------------------------------------------------------------

import { html, raw } from '../dom.js';
import {
  fmtInt, fmtPct, fmtMs, fmtTps, msParts, tpsParts, tokenParts,
  rateTone, statusInfo, runStatusInfo,
} from '../format.js';

export function modelAvatar(model, options = {}) {
  const { large = false, showName = false } = options;
  const className = `model-avatar${large ? ' model-avatar--lg' : ''}`;
  const src = model && model.icon ? `/icons/${encodeURIComponent(model.icon)}` : '';
  const image = src
    ? html`<img class="${className}" src="${src}" alt="" loading="lazy" data-model-icon>`
    : html`<span class="${className}" aria-hidden="true"></span>`;
  if (!showName) return image;
  return html`${image}<span class="cell-model__name">${(model && model.id) || ''}</span>`;
}

/** 图标缺失时隐藏破图（模板里不允许内联 onerror）。 */
export function bindModelAvatars(root) {
  if (!root) return;
  Array.prototype.forEach.call(root.querySelectorAll('img[data-model-icon]'), (img) => {
    const hide = () => img.classList.add('is-missing');
    img.addEventListener('error', hide, { once: true });
    if (img.complete && img.naturalWidth === 0) hide();
  });
}

/** 表格横向可滚动时给容器加右侧淡出提示（避免看起来像被裁掉）。 */
export function bindTableScrollHints(root) {
  if (!root) return;
  Array.prototype.forEach.call(root.querySelectorAll('.table-scroll'), (scroller) => {
    if (scroller.dataset.scrollHintBound === '1') return;
    scroller.dataset.scrollHintBound = '1';
    const parent = scroller.parentElement;
    if (!parent) return;

    const update = () => {
      const overflowing = scroller.scrollWidth > scroller.clientWidth + 2;
      const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 2;
      parent.classList.toggle('has-scroll-fade', overflowing && !atEnd);
    };

    scroller.addEventListener('scroll', update, { passive: true });
    if (typeof window.ResizeObserver === 'function') {
      const observer = new ResizeObserver(update);
      observer.observe(scroller);
    }
    update();
  });
}

export function statusBadge(status) {
  const info = statusInfo(status);
  if (info.tone === 'none') {
    return html`<span class="badge badge--outline">${info.label}</span>`;
  }
  return html`<span class="badge badge--${info.tone}">${info.label}</span>`;
}

export function statusDot(status) {
  const info = statusInfo(status);
  return html`<span class="status-dot status-dot--${info.tone === 'none' ? 'none' : info.tone}" aria-hidden="true"></span>`;
}

export function runStatusBadge(status) {
  const info = runStatusInfo(status);
  const tone = info.tone === 'none' ? 'outline' : info.tone === 'running' ? 'info' : info.tone;
  return html`<span class="badge badge--${tone}" title="${info.detail || ''}">${info.label}</span>`;
}

/** 成功率：横向进度条 + 百分比。 */
export function rateBar(value) {
  const numeric = Number(value);
  const clamped = Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0;
  const hasValue = Number.isFinite(numeric);
  return html`<div class="rate ${rateTone(value)}">
    <span class="rate__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"
          aria-valuenow="${hasValue ? clamped : 0}" aria-label="成功率 ${fmtPct(value)}">
      <span class="rate__fill" style="--pct:${clamped}%"></span>
    </span>
    <span class="rate__value">${fmtPct(value)}</span>
  </div>`;
}

/** 毫秒数值单元（TTFT ≥1000ms 自动转秒）。 */
export function msValue(value, tone = '') {
  const parts = msParts(value);
  const body = parts.unit
    ? html`${parts.value}<span class="unit">${parts.unit}</span>`
    : html`${parts.value}`;
  return tone ? html`<span class="${tone} num-strong">${body}</span>` : html`<span class="num-strong">${body}</span>`;
}

export function tpsValue(value, tone = '') {
  const parts = tpsParts(value);
  const body = parts.unit
    ? html`${parts.value}<span class="unit">${parts.unit}</span>`
    : html`${parts.value}`;
  return tone ? html`<span class="${tone}">${body}</span>` : html`<span>${body}</span>`;
}

export function tokenValue(value) {
  const parts = tokenParts(value);
  return parts.unit
    ? html`${parts.value}<span class="unit">${parts.unit}</span>`
    : html`${parts.value}`;
}

// Token provenance badge: exact usage from the server versus a character
// estimate. Protocol v2 records carry `token_source`; v1 rows are "unknown".
const TOKEN_SOURCES = {
  usage: { label: '实测', title: '服务端返回 usage，token 数为真实值' },
  estimate: { label: '估算', title: '服务端未返回 usage，按字符估算（约 ±15%）' },
  unknown: { label: 'v1', title: '协议 v1 记录：无口径信息（可能含前缀缓存命中）' },
};

export function tokenSourceBadge(record) {
  const source = (record && record.token_source) || 'unknown';
  const meta = TOKEN_SOURCES[source] || TOKEN_SOURCES.unknown;
  return html`<span class="badge badge--${source}" title="${meta.title}">${meta.label}</span>`;
}

// "in → out" token coordinate of one record, shown in the Token cell tooltip.
export function tokenCoordinate(record) {
  const input = Number(record && record.input_tokens) || 0;
  const output = Number(record && record.output_tokens) || 0;
  if (!input && !output) return '协议 v1 记录，无输入/输出 token 明细';
  return `输入 ≈${fmtInt(input)} tok → 输出 ≈${fmtInt(output)} tok（每请求均值）`;
}

export function protocolBadge(config) {
  const version = (config && config.protocol_version) || '';
  if (!version) return raw('');
  const cacheBust = !!(config && config.cache_bust);
  const usage = (config && config.stream_include_usage) || 'auto';
  const title = [
    `测量协议 v${version}`,
    `前缀缓存：${cacheBust ? '已绕过（头部 nonce）' : '未绕过（含缓存命中）'}`,
    `usage：${usage}`,
  ].join('\n');
  return html`<span class="badge badge--protocol" title="${title}">协议 v${version}</span>`;
}

export function errorCell(record) {
  const count = Number(record && record.error_count) || 0;
  const summary = record && record.error_summary && Object.keys(record.error_summary).length
    ? Object.entries(record.error_summary).map(([key, value]) => `${key} × ${value}`).join('\n')
    : (count ? `${count} 个请求失败` : '无错误');
  return html`<span class="err-count${count ? ' err-count--has' : ''}" title="${summary}">${fmtInt(count)}</span>`;
}

/** 单条记录的最小/最大值说明（表格次行或 tooltip）。 */
export function minMaxText(record) {
  if (!record) return '';
  const min = record.min_ttft_ms;
  const max = record.max_ttft_ms;
  return `min ${fmtMs(min)} · max ${fmtMs(max)}`;
}

export function exactTitle(parts, label) {
  return `${label}: ${parts.exact}`;
}

export function kpiCard(options) {
  const { label, value, unit = '', hint = '', accent = false, id = '' } = options;
  return html`
    <div class="kpi${accent ? ' kpi--accent' : ''}" ${id ? html`id="${id}"` : raw('')}>
      <span class="kpi__label">${label}</span>
      <span class="kpi__value">${value}${unit ? html`<span class="unit">${unit}</span>` : raw('')}</span>
      <span class="kpi__hint">${hint || raw('&nbsp;')}</span>
    </div>
  `;
}

export function statChip(label, value, unit = '', accent = false) {
  return html`<span class="chip${accent ? ' chip--accent' : ''}">${label}<strong>${value}${unit ? html` <span class="text-faint">${unit}</span>` : raw('')}</strong></span>`;
}

export function viewHead(options) {
  const { title, badge = '', sub = [], actions = [], back = null } = options;
  return html`
    <div class="view-head">
      <div class="view-head__main">
        ${back ? html`<a class="back-link" href="${back.href}">${back.label}</a>` : raw('')}
        <h1 class="view-title">${title}${badge}</h1>
        ${sub.length ? html`<div class="view-sub">${sub.map((item, index) => html`${index ? html`<span class="dot" aria-hidden="true">·</span>` : raw('')}<span>${item}</span>`)}</div>` : raw('')}
      </div>
      ${actions.length ? html`<div class="view-actions">${actions}</div>` : raw('')}
    </div>
  `;
}

export function safeTps(value) {
  return fmtTps(value);
}
