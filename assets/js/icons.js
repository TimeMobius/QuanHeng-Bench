// ---------------------------------------------------------------------------
// icons.js — 内联 SVG 图标（JS 侧生成；模板里只有少量静态图标）
// 全部 24×24、currentColor 描边，颜色随主题/上下文。
// ---------------------------------------------------------------------------

import { raw } from './dom.js';

const PATHS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M9 20.5h6M12 16.5v4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  download: '<path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  arrowLeft: '<path d="M19 12H5m0 0 6-6m-6 6 6 6"/>',
  arrowUpRight: '<path d="M7 17 17 7M9 7h8v8"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 13 4.5 4.5L19 7"/>',
  alert: '<path d="M12 3.5 22 20H2z"/><path d="M12 9.5v4.5M12 17.2v.3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.5 2"/>',
  gauge: '<path d="M4 18a8.5 8.5 0 1 1 16 0"/><path d="m12 13 4-4"/><circle cx="12" cy="14" r="1.6"/>',
  zap: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>',
  database: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  trophy: '<path d="M7 4.5h10v4a5 5 0 0 1-10 0z"/><path d="M7 6H4.5v1.5a3 3 0 0 0 3 3M17 6h2.5v1.5a3 3 0 0 1-3 3"/><path d="M12 13.5V17m-3.5 3.5h7L15 17h-6z"/>',
  activity: '<path d="M3 12h3.5l2.5-7 5 14 2.5-7H21"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3.5 12.5 8.5 4.7 8.5-4.7M3.5 17l8.5 4.7L20.5 17"/>',
  compare: '<path d="M4 6h7M4 12h7M4 18h7"/><path d="M17 6h3M17 12h3M17 18h3"/>',
  trend: '<path d="M3 17.5 9 11l4 4 7.5-8"/><path d="M15.5 7h5v5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 10h18M9 10v10M15 10v10"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  playCircle: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z"/>',
  server: '<rect x="3" y="3.5" width="18" height="7" rx="2"/><rect x="3" y="13.5" width="18" height="7" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  filter: '<path d="M3.5 5h17l-6.8 8.2v6.3l-3.4 1.5v-7.8z"/>',
  dot: '<circle cx="12" cy="12" r="3.5"/>',
};

/** 生成 SVG 图标（SafeHtml，可安全插入 html``）。 */
export function icon(name, options = {}) {
  const { size = 16, className = 'ico', title = '' } = options;
  const body = PATHS[name] || PATHS.dot;
  const label = title ? `<title>${String(title).replace(/[<>&"]/g, '')}</title>` : '';
  return raw(`<svg class="${className}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${label}${body}</svg>`);
}

export function hasIcon(name) {
  return Boolean(PATHS[name]);
}
