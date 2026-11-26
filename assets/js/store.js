// ---------------------------------------------------------------------------
// store.js — 全局状态 + 偏好持久化（localStorage）
// 视图不直接改 DOM 数据，全部从这里读；写入走 commit() 并广播。
// ---------------------------------------------------------------------------

export const PREF = {
  theme: 'hc.theme',
  autoRefresh: 'hc.autoRefresh',
  lastModel: 'hc.lastModel',
  compareModels: 'hc.compareModels',
  trendModel: 'hc.trend.model',
  trendMetric: 'hc.trend.metric',
  trendConcurrency: 'hc.trend.concurrency',
  trendRange: 'hc.trend.range',
  modelSort: 'hc.modelSort',
};

export function readPref(key, fallback) {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return fallback;
    try {
      const parsed = JSON.parse(stored);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (err) {
      return stored;
    }
  } catch (err) {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    /* 隐私模式/localStorage 被禁用时静默降级 */
  }
}

function readShell() {
  const body = document.body || {};
  const data = body.dataset || {};
  const path = String(window.location.pathname || '');
  const historyMatch = /^\/history\/([^/]+)/.exec(path);
  const page = data.page || (historyMatch ? 'history' : 'dashboard');
  const pathDate = historyMatch ? decodeURIComponent(historyMatch[1]) : '';
  return {
    page,
    date: data.date || pathDate || '',
    today: data.today || '',
    baseUrl: data.baseUrl || '',
  };
}

export const shell = readShell();

function clampConcurrency(value) {
  if (value === '' || value === null || value === undefined) return '';
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : '';
}

const initialCompare = readPref(PREF.compareModels, []);
const initialRange = readPref(PREF.trendRange, '7');

const state = {
  // 页面外壳
  page: shell.page,
  today: shell.today,
  baseUrl: shell.baseUrl,
  upstreamBase: /^https?:\/\//i.test(shell.baseUrl) ? shell.baseUrl : '',

  // 数据
  dashboard: null,
  status: null,
  runLog: [],
  modelsIndex: null, // /api/models 缓存
  date: shell.date, // '' = 今天（后端解析）
  loading: false,
  error: null,
  updatedAt: null,
  lastLoadedAt: null,

  // 偏好
  themeMode: readPref(PREF.theme, 'auto'),
  effectiveTheme: document.documentElement.getAttribute('data-theme') || 'light',
  autoRefresh: readPref(PREF.autoRefresh, true) !== false,
  lastModel: readPref(PREF.lastModel, '') || '',
  compareModels: Array.isArray(initialCompare) ? initialCompare.slice(0, 8) : [],
  trend: {
    model: readPref(PREF.trendModel, '') || '',
    metric: readPref(PREF.trendMetric, 'ttft') || 'ttft',
    concurrency: clampConcurrency(readPref(PREF.trendConcurrency, '')),
    range: ['7', '30', 'all'].includes(initialRange) ? initialRange : '7',
  },
};

const listeners = new Set();

export function getState() {
  return state;
}

export function subscribe(listener, options = {}) {
  listeners.add(listener);
  if (options.immediate) {
    try {
      listener(state, { reason: 'init' });
    } catch (err) {
      console.error('[store] listener error', err);
    }
  }
  return () => listeners.delete(listener);
}

/** 合并状态并通知订阅者；reason 用于区分“加载/刷新/偏好”等场景。 */
export function commit(patch, reason = 'update') {
  if (patch && typeof patch === 'object') Object.assign(state, patch);
  listeners.forEach((listener) => {
    try {
      listener(state, { reason });
    } catch (err) {
      console.error('[store] listener error', err);
    }
  });
}

/* ------------------------------- 选择器 ------------------------------- */

export function modelsOf(stateValue = state) {
  const dashboard = stateValue.dashboard;
  return dashboard && Array.isArray(dashboard.models) ? dashboard.models : [];
}

export function findModel(modelId, stateValue = state) {
  if (!modelId) return null;
  return modelsOf(stateValue).find((model) => model.id === modelId) || null;
}

export function testedModels(stateValue = state) {
  return modelsOf(stateValue).filter((model) => model.has_data || model.tested
    || (Array.isArray(model.records) && model.records.length > 0));
}

export function modelIds(stateValue = state) {
  return modelsOf(stateValue).map((model) => model.id);
}

/** 当前日期（explicit 或后端返回的 date 或 today）。 */
export function selectedDate(stateValue = state) {
  return stateValue.date || (stateValue.dashboard && stateValue.dashboard.date) || stateValue.today || '';
}

export function availableDates(stateValue = state) {
  const dashboard = stateValue.dashboard;
  return dashboard && Array.isArray(dashboard.dates) ? dashboard.dates : [];
}

export function summaryOf(stateValue = state) {
  return (stateValue.dashboard && stateValue.dashboard.summary) || null;
}

export function statusOf(stateValue = state) {
  return stateValue.status || (stateValue.dashboard && stateValue.dashboard.status) || null;
}

export function configOf(stateValue = state) {
  return (stateValue.dashboard && stateValue.dashboard.config) || null;
}

export function isRunning(stateValue = state) {
  const status = statusOf(stateValue);
  return Boolean(status && status.running);
}

/** 最近一次查看的模型 → 决定“模型”标签页的落地页。 */
export function defaultModelId(stateValue = state) {
  const preferred = stateValue.lastModel && findModel(stateValue.lastModel, stateValue);
  if (preferred) return preferred.id;
  const tested = testedModels(stateValue);
  if (tested.length) return tested[0].id;
  const all = modelsOf(stateValue);
  return all.length ? all[0].id : '';
}
