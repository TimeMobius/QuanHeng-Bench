// ---------------------------------------------------------------------------
// api.js — 唯一数据出口（契约 docs/API_CONTRACT.md）
// 只允许：/api/dashboard /api/status /api/trend /api/run-log /api/models
//          /api/export.csv 以及 POST /api/run-test|run-model|cancel
// ---------------------------------------------------------------------------

const JSON_TIMEOUT_MS = 25_000;
const STATUS_TIMEOUT_MS = 8_000;

/** 契约第 11 节：页面外壳注入 data-base-url；http(s) 开头视为上游展示地址而非应用前缀。 */
function resolveBaseUrl() {
  const raw = (document.body && document.body.dataset.baseUrl) || '';
  const value = String(raw).trim();
  if (!value) return { apiBase: '', upstreamBase: '' };
  if (/^https?:\/\//i.test(value)) return { apiBase: '', upstreamBase: value };
  return { apiBase: value.replace(/\/+$/, ''), upstreamBase: '' };
}

const BASE = resolveBaseUrl();
export const apiBase = BASE.apiBase;
export const upstreamBase = BASE.upstreamBase;

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status || 0;
    this.url = options.url || '';
    this.payload = options.payload === undefined ? null : options.payload;
  }
}

async function request(path, options = {}) {
  const {
    method = 'GET',
    body = null,
    timeout = JSON_TIMEOUT_MS,
    signal = null,
  } = options;

  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  const abortHandler = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortHandler, { once: true });
  }

  const headers = { Accept: 'application/json' };
  if (body !== null) headers['Content-Type'] = 'application/json';

  try {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (err) {
        payload = text;
      }
    }

    if (!response.ok) {
      const detail = payload && typeof payload === 'object'
        ? payload.error || payload.message
        : null;
      throw new ApiError(detail || `请求失败（HTTP ${response.status}）`, {
        status: response.status,
        url: path,
        payload,
      });
    }
    return payload;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err && err.name === 'AbortError') {
      throw new ApiError(timedOut ? '请求超时，请稍后重试' : '请求已取消', { url: path });
    }
    throw new ApiError('网络错误，无法连接服务', { url: path, payload: err });
  } finally {
    window.clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortHandler);
  }
}

function withQuery(path, params) {
  const search = new URLSearchParams();
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (value === null || value === undefined || value === '') return;
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export const api = {
  /** 整页数据（契约 §1）。date 省略则后端取“今天”。 */
  dashboard(date) {
    return request(withQuery('/api/dashboard', { date }));
  },

  /** 轻量轮询（契约 §2）。 */
  status(options = {}) {
    return request('/api/status', { timeout: STATUS_TIMEOUT_MS, signal: options.signal });
  },

  /** 跨日期趋势（契约 §7）。concurrency 为空表示按请求数加权汇总。 */
  trend({ model, metric, concurrency } = {}, options = {}) {
    return request(withQuery('/api/trend', { model, metric, concurrency }), { signal: options.signal });
  },

  /** 运行日志（契约 §10）。 */
  runLog(limit = 20) {
    return request(withQuery('/api/run-log', { limit }));
  },

  /** 模型列表，带后端缓存（契约 §6）。 */
  models(refresh = false) {
    return request(withQuery('/api/models', { refresh: refresh ? 1 : '' }));
  },

  runTest() {
    return request('/api/run-test', { method: 'POST', timeout: 15_000 });
  },

  runModel(model) {
    return request('/api/run-model', {
      method: 'POST',
      body: { model },
      timeout: 15_000,
    });
  },

  cancel() {
    return request('/api/cancel', { method: 'POST', timeout: 15_000 });
  },

  /** CSV 下载地址（契约 §8）；不走 fetch，交给浏览器下载。 */
  exportCsvUrl(date, model) {
    return withQuery(`${apiBase}/api/export.csv`, { date, model });
  },
};
