// ---------------------------------------------------------------------------
// dom.js — 极小 DOM/模板工具：自动转义的安全 HTML 片段 + 事件委托
// 视图全部通过 html`` 生成标记，插值默认转义，模型名里的引号/尖括号不会破坏结构。
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML 转义；null/undefined → 空串。 */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** 已经转义/可信的标记片段。 */
export class SafeHtml {
  constructor(value) {
    this.value = String(value === null || value === undefined ? '' : value);
  }
  toString() {
    return this.value;
  }
}

export function raw(value) {
  return value instanceof SafeHtml ? value : new SafeHtml(value);
}

export function isSafe(value) {
  return value instanceof SafeHtml;
}

/**
 * 标签模板：`html`<b>${name}</b>``。
 * 数组按顺序拼接；false/null/undefined 会被跳过；SafeHtml 原样输出。
 */
export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i >= values.length) continue;
    const value = values[i];
    if (value === null || value === undefined || value === false) continue;
    if (Array.isArray(value)) {
      out += value
        .map((item) => (item === null || item === undefined || item === false
          ? ''
          : isSafe(item) ? item.value : esc(item)))
        .join('');
    } else if (isSafe(value)) {
      out += value.value;
    } else if (typeof value === 'number') {
      out += String(value);
    } else {
      out += esc(value);
    }
  }
  return new SafeHtml(out);
}

/** 把 SafeHtml / 字符串写进节点（默认转义）。 */
export function setHtml(node, chunk) {
  if (!node) return;
  node.innerHTML = isSafe(chunk) ? chunk.value : esc(chunk);
}

export function qs(selector, root = document) {
  if (!root) return null;
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  if (!root) return [];
  return Array.prototype.slice.call(root.querySelectorAll(selector));
}

export function closest(node, selector) {
  if (!node || node.nodeType !== 1) return null;
  return node.closest(selector);
}

/** 绑定事件，返回解绑函数。 */
export function on(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** 事件委托：命中 selector 时回调 (event, matchedElement)。 */
export function delegate(root, type, selector, handler, options) {
  return on(root, type, (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const matched = target.closest(selector);
    if (!matched || !root.contains(matched)) return;
    handler(event, matched);
  }, options);
}

/**
 * 统一交互入口：任何带 data-action="name" 的按钮/链接都会被路由到 actions[name]。
 * 这样模板与 JS 生成的标记里都不需要内联 onclick。
 */
export function bindActions(root, actions) {
  return delegate(root, 'click', '[data-action]', (event, el) => {
    const name = el.dataset.action;
    const handler = actions[name];
    if (typeof handler !== 'function') return;
    if (el.tagName !== 'A' || el.getAttribute('href')) event.preventDefault();
    handler(el, event);
  });
}

/** 读取 CSS 变量（图表配色跟随主题）。 */
export function cssVar(name, fallback = '') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (value || '').trim() || fallback;
}

/** 数值 → 百分比字符串，限制在 0–100。 */
export function pctValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0%';
  return `${Math.min(100, Math.max(0, num))}%`;
}

export function scrollToTop() {
  try {
    window.scrollTo({ top: 0, behavior: 'auto' });
  } catch (err) {
    window.scrollTo(0, 0);
  }
}
