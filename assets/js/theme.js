// ---------------------------------------------------------------------------
// theme.js — 主题：默认跟随 prefers-color-scheme，手动切换存 localStorage
// 首屏主题由 base.html <head> 里的内联脚本先行设置，这里只负责后续切换与广播。
// ---------------------------------------------------------------------------

import { PREF, readPref, writePref, getState, commit } from './store.js';

export const THEME_MODES = ['auto', 'light', 'dark'];
const THEME_LABELS = { auto: '跟随系统', light: '浅色', dark: '深色' };

const media = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

export function systemPrefersDark() {
  return Boolean(media && media.matches);
}

function resolveDark(mode) {
  return mode === 'dark' || (mode === 'auto' && systemPrefersDark());
}

/** 应用主题；persist=false 时不写 localStorage（例如系统主题变化联动）。 */
export function applyTheme(mode, options = {}) {
  const next = THEME_MODES.includes(mode) ? mode : 'auto';
  const dark = resolveDark(next);
  const root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-theme-mode', next);
  if (options.persist !== false) writePref(PREF.theme, next);

  commit({ themeMode: next, effectiveTheme: dark ? 'dark' : 'light' }, 'theme');
  window.dispatchEvent(new CustomEvent('hc:themechange', {
    detail: { mode: next, theme: dark ? 'dark' : 'light' },
  }));
  return next;
}

export function initTheme() {
  const stored = readPref(PREF.theme, 'auto');
  applyTheme(THEME_MODES.includes(stored) ? stored : 'auto', { persist: false });
  if (media) {
    const handler = () => {
      if (getState().themeMode === 'auto') applyTheme('auto', { persist: false });
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', handler);
    else if (typeof media.addListener === 'function') media.addListener(handler);
  }
}

export function cycleTheme() {
  const index = THEME_MODES.indexOf(getState().themeMode);
  const next = THEME_MODES[(index + 1) % THEME_MODES.length];
  return applyTheme(next);
}

export function themeLabel(mode) {
  return THEME_LABELS[mode] || THEME_LABELS.auto;
}

export function themeIconName(mode) {
  if (mode === 'light') return 'sun';
  if (mode === 'dark') return 'moon';
  return 'monitor';
}

/** 主题变化订阅（图表重绘、图标刷新都走这里）。 */
export function onThemeChange(handler) {
  const listener = (event) => handler(event.detail || {});
  window.addEventListener('hc:themechange', listener);
  return () => window.removeEventListener('hc:themechange', listener);
}
