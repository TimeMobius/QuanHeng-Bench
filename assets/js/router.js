// ---------------------------------------------------------------------------
// router.js — hash 路由
//   #/overview | #/model/<id> | #/compare?models=a,b
//   #/trend?model=&metric=&concurrency= | #/runs
// 所有视图都支持附加 &date=YYYY-MM-DD（缺省=今天），保证刷新后视图/模型/日期都在。
// ---------------------------------------------------------------------------

export const VIEW_NAMES = ['overview', 'model', 'compare', 'trend', 'runs'];

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (err) {
    return segment;
  }
}

/** 解析 hash → { view, id, params, date }。未知视图回落到 overview。 */
export function parseHash(hash = window.location.hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const queryIndex = raw.indexOf('?');
  const pathPart = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const queryPart = queryIndex >= 0 ? raw.slice(queryIndex + 1) : '';

  const segments = pathPart.split('/').filter(Boolean);
  let view = segments[0] || 'overview';
  if (!VIEW_NAMES.includes(view)) view = 'overview';

  let id = '';
  if (view === 'model') {
    id = segments.slice(1).map(safeDecode).join('/');
  }

  let params;
  try {
    params = new URLSearchParams(queryPart);
  } catch (err) {
    params = new URLSearchParams();
  }

  return {
    view,
    id,
    params,
    date: params.get('date') || '',
  };
}

/** 由视图 + 参数生成 hash（逗号保持可读：models=a,b）。 */
export function hashFor(view, options = {}) {
  const name = VIEW_NAMES.includes(view) ? view : 'overview';
  const id = options.id ? String(options.id) : '';
  const params = options.params || {};

  const parts = [];
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (value === null || value === undefined || value === '') return;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value).replace(/%2C/gi, ',')}`);
  });

  let hash = `#/${name}`;
  if (id) hash += `/${encodeURIComponent(id)}`;
  return parts.length ? `${hash}?${parts.join('&')}` : hash;
}

export function currentRoute() {
  return parseHash();
}

/**
 * 导航到指定视图。
 * replace=true 用于筛选类变更（日期/指标/并发），避免历史记录被刷屏。
 */
export function navigate(view, options = {}, { replace = false } = {}) {
  const next = hashFor(view, options);
  const current = window.location.hash || '#/overview';
  if (next === current) return false;

  if (replace) {
    try {
      window.history.replaceState(null, '', next);
    } catch (err) {
      window.location.hash = next;
      return true;
    }
    window.dispatchEvent(new CustomEvent('hc:routechange', { detail: { hash: next } }));
    return true;
  }

  window.location.hash = next;
  return true;
}

/** 只在查询参数层面更新当前 hash（沿用 replaceState）。 */
export function updateQuery(view, options = {}) {
  return navigate(view, options, { replace: true });
}

/** 路由变化订阅；hashchange 与 replaceState 都会触发。 */
export function onRouteChange(handler) {
  const listener = (event) => {
    const hash = (event && event.detail && event.detail.hash) || window.location.hash;
    handler(parseHash(hash));
  };
  window.addEventListener('hashchange', listener);
  window.addEventListener('hc:routechange', listener);
  return () => {
    window.removeEventListener('hashchange', listener);
    window.removeEventListener('hc:routechange', listener);
  };
}

/** 逗号分隔参数 → 数组。 */
export function listParam(params, key) {
  const value = params ? params.get(key) : '';
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => safeDecode(item.trim()))
    .filter(Boolean);
}
