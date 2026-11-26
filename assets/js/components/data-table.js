// ---------------------------------------------------------------------------
// components/data-table.js — 可排序表格（表头点击排序 + aria-sort + scope=col）
// ---------------------------------------------------------------------------

import { html, raw, esc } from '../dom.js';

function isEmptyValue(value) {
  return value === null || value === undefined || value === ''
    || (typeof value === 'number' && !Number.isFinite(value));
}

/** 排序规则：空值永远排最后；数字按数值；字符串按中文 locale。 */
export function sortRows(rows, columns, sort) {
  if (!sort || !sort.key) return rows.slice();
  const column = columns.find((item) => item.key === sort.key);
  if (!column) return rows.slice();
  const direction = sort.dir === 'asc' ? 1 : -1;
  const valueOf = (row) => (typeof column.sortValue === 'function' ? column.sortValue(row) : row[column.key]);

  return rows.slice().sort((rowA, rowB) => {
    const a = valueOf(rowA);
    const b = valueOf(rowB);
    const aEmpty = isEmptyValue(a);
    const bEmpty = isEmptyValue(b);
    if (aEmpty || bEmpty) {
      if (aEmpty && bEmpty) return 0;
      return aEmpty ? 1 : -1;
    }
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * direction;
    return String(a).localeCompare(String(b), 'zh-CN', { numeric: true }) * direction;
  });
}

/** 点击表头：同列切换升降序，新列使用列的 sortDefault。 */
export function nextSort(current, key, columns) {
  const column = columns.find((item) => item.key === key) || {};
  if (!current || current.key !== key) {
    return { key, dir: column.sortDefault || 'desc' };
  }
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

function headerCell(column, sort) {
  const sorted = sort && sort.key === column.key;
  const ariaSort = column.sortable
    ? (sorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none')
    : null;
  const arrow = sorted ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';

  const attrs = raw([
    'scope="col"',
    column.align === 'left' ? 'class="is-left"' : '',
    ariaSort ? `aria-sort="${ariaSort}"` : '',
  ].filter(Boolean).join(' '));

  const content = column.sortable
    ? html`<button class="th-btn" type="button" data-sort-key="${column.key}"
             title="${column.sortHint || `按${column.label}排序`}">${column.label}<span class="sort-ind" aria-hidden="true">${arrow}</span></button>`
    : html`${column.label}`;

  return html`<th ${attrs}>${content}</th>`;
}

function bodyCell(column, row) {
  const attrs = [];
  if (column.align === 'left') attrs.push('class="is-left"');
  const title = typeof column.cellTitle === 'function' ? column.cellTitle(row) : '';
  if (title) attrs.push(`title="${esc(title)}"`);

  const content = typeof column.render === 'function' ? column.render(row) : row[column.key];
  const sub = typeof column.sub === 'function' ? column.sub(row) : '';
  const attrString = attrs.length ? raw(attrs.join(' ')) : raw('');

  return html`<td ${attrString}>${content}${sub ? html`<span class="sub">${sub}</span>` : raw('')}</td>`;
}

/**
 * 渲染表格。
 * columns: [{ key, label, align, sortable, sortDefault, sortValue(row), render(row), sub(row), cellTitle(row) }]
 */
export function renderTable(options) {
  const {
    columns,
    rows,
    sort = null,
    ariaLabel = '',
    caption = '',
    emptyText = '暂无数据',
    rowClass = null,
    rowAttrs = null,
  } = options;

  const sorted = sortRows(rows, columns, sort);
  const tableAttrs = raw(`${ariaLabel ? `aria-label="${esc(ariaLabel)}"` : ''}`);

  const body = sorted.length === 0
    ? html`<tr><td class="is-left" colspan="${columns.length}">
        <p class="hint" style="padding:18px 4px">${emptyText}</p>
      </td></tr>`
    : sorted.map((row) => {
      const cls = typeof rowClass === 'function' ? rowClass(row) : '';
      const extra = typeof rowAttrs === 'function' ? rowAttrs(row) : raw('');
      return html`<tr class="${cls}" ${extra}>${columns.map((column) => bodyCell(column, row))}</tr>`;
    });

  return html`
    <div class="table-scroll">
      <table class="data-table" ${tableAttrs}>
        ${caption ? html`<caption>${caption}</caption>` : raw('')}
        <thead><tr>${columns.map((column) => headerCell(column, sort))}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

/** 表头点击排序（监听器随视图容器销毁，不会累积）。 */
export function bindTableSort(root, onSort) {
  if (!root) return;
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-sort-key]');
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    onSort(button.dataset.sortKey);
  });
}

/** 整行可点击跳转（data-row-href），支持 Enter / Space。 */
export function bindRowLinks(root) {
  if (!root) return;
  const activate = (row) => {
    const href = row.dataset.rowHref;
    if (!href) return;
    if (href.startsWith('#')) window.location.hash = href;
    else window.location.href = href;
  };
  root.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-row-href]');
    if (!row || !root.contains(row)) return;
    if (event.target.closest('a, button, input, select')) return;
    activate(row);
  });
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-row-href]');
    if (!row) return;
    event.preventDefault();
    activate(row);
  });
}
