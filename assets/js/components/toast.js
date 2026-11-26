// ---------------------------------------------------------------------------
// components/toast.js — 非阻塞提示（aria-live=polite），错误带“重试”按钮
// ---------------------------------------------------------------------------

import { html, raw, setHtml, esc } from '../dom.js';
import { icon } from '../icons.js';

const MAX_TOASTS = 4;

function stack() {
  return document.getElementById('toast-stack');
}

function iconFor(type) {
  if (type === 'error') return icon('alert', { size: 15 });
  if (type === 'success') return icon('check', { size: 15 });
  if (type === 'warn') return icon('alert', { size: 15 });
  return icon('info', { size: 15 });
}

/**
 * 显示一条 toast。
 * @param {string} message 主要内容
 * @param {object} options { type, title, actionLabel, onAction, duration }
 */
export function toast(message, options = {}) {
  const container = stack();
  if (!container) return null;

  const {
    type = 'info',
    title = '',
    actionLabel = '',
    onAction = null,
    duration = type === 'error' ? 8000 : 4200,
  } = options;

  while (container.children.length >= MAX_TOASTS) {
    container.removeChild(container.firstElementChild);
  }

  const node = document.createElement('div');
  node.className = `toast toast--${type}`;
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const action = actionLabel
    ? html`<div class="toast__action"><button class="btn btn-outline btn-sm" type="button" data-toast-action>${actionLabel}</button></div>`
    : raw('');

  setHtml(node, html`
    <span class="toast__icon">${iconFor(type)}</span>
    <div class="toast__body">
      ${title ? html`<div class="toast__title">${title}</div>` : raw('')}
      <div class="toast__text">${message}</div>
      ${action}
    </div>
    <button class="toast__close" type="button" aria-label="关闭提示" data-toast-close>${icon('close', { size: 13 })}</button>
  `);

  let timer = null;
  const remove = () => {
    if (timer) window.clearTimeout(timer);
    node.remove();
  };

  node.querySelector('[data-toast-close]').addEventListener('click', remove);
  const actionButton = node.querySelector('[data-toast-action]');
  if (actionButton && typeof onAction === 'function') {
    actionButton.addEventListener('click', () => {
      remove();
      onAction();
    });
  }
  if (duration > 0) timer = window.setTimeout(remove, duration);

  container.appendChild(node);
  return remove;
}

export function notifyError(error, options = {}) {
  const message = (error && error.message) || (typeof error === 'string' ? error : '发生未知错误');
  return toast(message, {
    type: 'error',
    title: options.title || '出错了',
    actionLabel: options.retry ? '重试' : '',
    onAction: options.retry || null,
    duration: 9000,
  });
}

export function notifySuccess(message, options = {}) {
  return toast(message, { type: 'success', title: options.title || '完成', ...options });
}

/** 转义后的短文本，供标题等场景使用。 */
export function plain(value) {
  return esc(value);
}
