// ---------------------------------------------------------------------------
// main.js — 应用引导：主题 / 页头 / 路由 / 数据加载 / 运行监控 / 视图分发
// 所有视图都是原生 ES Module，无构建步骤；刷新数据不整页 reload。
// ---------------------------------------------------------------------------

import {
  getState, commit, writePref, PREF, shell,
  selectedDate, availableDates, defaultModelId, isRunning, statusOf,
} from './store.js';
import { api } from './api.js';
import { parseHash, hashFor, navigate, onRouteChange } from './router.js';
import { html, raw, setHtml, qsa, bindActions, scrollToTop } from './dom.js';
import { icon } from './icons.js';
import { initTheme, cycleTheme, themeIconName, themeLabel, onThemeChange } from './theme.js';
import { fmtDateLabel, fmtDateTime, fmtInt, runStatusInfo, fmtMs } from './format.js';
import { destroyCharts, refreshCharts, exportChartPng } from './charts.js';
import { createPopover } from './components/popover.js';
import { createDatePicker } from './components/date-picker.js';
import { createRunMonitor } from './components/run-monitor.js';
import { toast, notifyError } from './components/toast.js';
import { skeletonView, errorState } from './components/skeleton.js';

import * as overviewView from './views/overview.js';
import * as modelView from './views/model.js';
import * as compareView from './views/compare.js';
import * as trendView from './views/trend.js';
import * as runsView from './views/runs.js';

const VIEW_MODULES = {
  overview: overviewView,
  model: modelView,
  compare: compareView,
  trend: trendView,
  runs: runsView,
};

const MAX_COMPARE = 6;

let loadingInFlight = false;
let queuedReload = false;
let initialRouteResolved = false;
let lastView = '';
let currentView = null;
let monitor = null;
let datePicker = null;
let datePopover = null;
let exportPopover = null;
let runBusy = false;

/* ------------------------------- 小工具 ------------------------------- */

function clockText(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function resolvedDate() {
  const state = getState();
  return state.date || (state.dashboard && state.dashboard.date) || state.today || '';
}

function routeDate(route) {
  if (route.date) return route.date;
  if (!initialRouteResolved) return shell.date || '';
  return '';
}

function currentModelId() {
  const route = parseHash();
  const state = getState();
  if (route.view === 'model' && route.id) return route.id;
  if (typeof modelView.currentModelId === 'function') {
    const fromView = modelView.currentModelId();
    if (fromView) return fromView;
  }
  if (state.lastModel) return state.lastModel;
  return defaultModelId(state);
}

function replaceHash(hash) {
  if (!hash || window.location.hash === hash) return;
  try {
    window.history.replaceState(null, '', hash);
  } catch (err) {
    /* 部分环境禁止 replaceState，忽略即可 */
  }
}

function paramsObject(params) {
  const result = {};
  if (!params || typeof params.forEach !== 'function') return result;
  params.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/* ------------------------------- 主题 ------------------------------- */

function updateThemeButton() {
  const button = document.getElementById('theme-btn');
  if (!button) return;
  const mode = getState().themeMode;
  const label = themeLabel(mode);
  button.setAttribute('aria-label', `切换主题（当前：${label}）`);
  button.title = `当前主题：${label}（点击切换：跟随系统 → 浅色 → 深色）`;
  const host = button.querySelector('[data-theme-icon]');
  if (host) {
    setHtml(host, icon(themeIconName(mode), { size: 17, className: `theme-icon${mode === 'auto' ? ' theme-icon--auto' : ''}` }));
  }
}

/* ------------------------------- 页头 ------------------------------- */

function updateDateLabels() {
  const label = fmtDateLabel(resolvedDate());
  qsa('[data-date-label]').forEach((node) => {
    node.textContent = label;
  });
  const brandSub = document.querySelector('.brand__sub');
  if (brandSub) {
    const state = getState();
    const dashboard = state.dashboard;
    const tested = dashboard ? (dashboard.models || []).filter((model) => model.has_data).length : 0;
    brandSub.textContent = dashboard ? `${label} · ${fmtInt(tested)} 个模型有数据` : label;
  }
}

function updateStatusStrip() {
  const state = getState();
  const status = statusOf(state) || {};
  const running = Boolean(status.running);

  const pill = document.getElementById('status-pill');
  const message = document.getElementById('status-msg');
  const progress = document.querySelector('[data-status-progress]');
  const bar = document.querySelector('[data-status-bar]');
  const percentLabel = document.querySelector('[data-status-pct]');
  const track = document.querySelector('[data-status-track]');
  const updated = document.querySelector('[data-updated]');

  // status.last_run_status 只在本次进程跑过测试后才有值 → 用 run_log 最近一条兜底
  const dashboard = state.dashboard;
  const logRows = dashboard && Array.isArray(dashboard.run_log) && dashboard.run_log.length
    ? dashboard.run_log
    : (Array.isArray(state.runLog) ? state.runLog : []);
  const lastLog = logRows.length ? logRows[0] : null;
  const idleStatus = status.last_run_status || (lastLog && lastLog.status) || '';
  const idleRunAt = status.last_run || (lastLog && (lastLog.finished_at || lastLog.started_at)) || '';
  const idleMessage = (lastLog && lastLog.message) || status.message || '';
  const info = runStatusInfo(idleStatus);

  if (pill) {
    if (running) {
      pill.className = 'pill pill--running';
      pill.textContent = '运行中';
    } else if (idleStatus) {
      pill.className = `pill pill--${info.tone === 'none' ? 'none' : info.tone}`;
      pill.textContent = info.label;
    } else {
      pill.className = 'pill pill--none';
      pill.textContent = '就绪';
    }
  }

  if (message) {
    if (running) {
      message.textContent = `${status.message || '正在运行测试…'}${status.cancel_requested ? '（已请求取消）' : ''}`;
    } else if (idleRunAt) {
      message.textContent = `上次运行 ${fmtDateTime(idleRunAt)}${idleMessage ? ` · ${idleMessage}` : ''}`;
    } else {
      message.textContent = idleMessage || '尚无运行记录，点击右上角「运行测试」开始';
    }
  }

  if (progress) progress.hidden = !running;
  const percent = Math.round(Math.max(0, Math.min(1, status.progress || 0)) * 100);
  if (bar) bar.style.width = running ? `${percent}%` : '0%';
  if (percentLabel) percentLabel.textContent = `${percent}%`;
  if (track) track.setAttribute('aria-valuenow', String(running ? percent : 0));

  if (updated) {
    updated.textContent = state.updatedAt ? `数据更新于 ${clockText(state.updatedAt)}` : '数据加载中…';
  }

  const runButton = document.getElementById('run-btn');
  const cancelButton = document.getElementById('cancel-btn');
  if (runButton) {
    runButton.disabled = running || runBusy;
    const label = runButton.querySelector('[data-run-label]');
    if (label) label.textContent = running ? '运行中…' : '运行测试';
  }
  if (cancelButton) cancelButton.hidden = !running;
}

function updateExportMenu() {
  const modelItem = document.querySelector('[data-action="export-model"]');
  const note = document.querySelector('[data-export-note]');
  const id = currentModelId();
  if (modelItem) {
    modelItem.disabled = !id;
    modelItem.textContent = id ? `导出当前模型 CSV（${id}）` : '导出当前模型 CSV';
  }
  if (note) note.textContent = `日期 ${resolvedDate() || '今天'} · 来源 /api/export.csv`;
}

function updateTabs(route) {
  const tabs = qsa('#view-tabs .tab');
  tabs.forEach((tab) => {
    const isActive = tab.dataset.view === route.view;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
    if (isActive) {
      const panel = document.getElementById('view-root');
      if (panel) panel.setAttribute('aria-labelledby', tab.id);
    }
  });

  const modelTab = document.getElementById('tab-model');
  if (modelTab) {
    const id = currentModelId();
    const date = resolvedDate();
    if (id) modelTab.setAttribute('href', hashFor('model', { id, params: { date } }));
    else modelTab.setAttribute('href', '#/model');
  }
  const compareTab = document.getElementById('tab-compare');
  if (compareTab) {
    const state = getState();
    const ids = state.compareModels || [];
    compareTab.setAttribute('href', hashFor('compare', { params: ids.length ? { models: ids.join(',') } : {} }));
  }
}

function updateChrome() {
  updateDateLabels();
  updateStatusStrip();
  updateExportMenu();
  updateThemeButton();
  updateTabs(parseHash());
}

function updateDatePicker() {
  if (!datePicker) return;
  const state = getState();
  const today = (state.dashboard && state.dashboard.today) || state.today || '';
  datePicker.setData({
    dates: availableDates(state),
    selected: resolvedDate(),
    today,
  });
}

function bindHeader() {
  // 主题
  const themeButton = document.getElementById('theme-btn');
  if (themeButton) themeButton.addEventListener('click', () => cycleTheme());

  // 日期选择器
  const dateButton = document.getElementById('date-btn');
  const datePanel = document.getElementById('date-popover');
  const dateSearch = document.getElementById('date-search');
  const dateList = document.getElementById('date-list');
  const dateHint = datePanel ? datePanel.querySelector('[data-date-hint]') : null;

  if (datePanel && dateButton && dateList) {
    datePicker = createDatePicker({
      panel: datePanel,
      searchInput: dateSearch,
      list: dateList,
      hint: dateHint,
      onSelect: (date) => selectDate(date),
      closePanel: () => datePopover && datePopover.close(),
    });
    datePopover = createPopover({
      trigger: dateButton,
      panel: datePanel,
      onOpen: () => datePicker.reset(),
    });
  }

  // 导出菜单
  const exportButton = document.getElementById('export-btn');
  const exportList = document.getElementById('export-list');
  if (exportButton && exportList) {
    exportPopover = createPopover({
      trigger: exportButton,
      panel: exportList,
      onOpen: () => updateExportMenu(),
    });
  }

  // 刷新 / 运行 / 取消
  const refreshButton = document.getElementById('refresh-btn');
  if (refreshButton) refreshButton.addEventListener('click', () => reloadDashboard());

  const runButton = document.getElementById('run-btn');
  if (runButton) runButton.addEventListener('click', () => triggerRun());

  const cancelButton = document.getElementById('cancel-btn');
  if (cancelButton) cancelButton.addEventListener('click', () => triggerCancel());

  // 页头里的 data-action（导出、回到今天）
  const header = document.querySelector('.app-header');
  if (header) {
    bindActions(header, {
      'export-all': () => {
        if (exportPopover) exportPopover.close();
        exportCsv(null);
      },
      'export-model': () => {
        if (exportPopover) exportPopover.close();
        exportCsv(currentModelId());
      },
      'date-today': () => {
        if (datePopover) datePopover.close();
        selectDate('');
      },
    });
  }

  bindTabKeys();
}

function bindTabKeys() {
  const tabs = qsa('#view-tabs .tab');
  tabs.forEach((tab, index) => {
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      const next = tabs[nextIndex];
      next.focus();
      next.click();
    });
  });
}

/* ------------------------------- 数据 ------------------------------- */

function renderSkeletonMount() {
  const host = document.getElementById('view-root');
  if (!host) return;
  const mount = document.createElement('div');
  mount.className = 'view-mount';
  host.innerHTML = '';
  host.appendChild(mount);
  setHtml(mount, skeletonView({ kpis: 7, charts: 2, table: true }));
  currentView = null;
}

function renderErrorMount(error) {
  const host = document.getElementById('view-root');
  if (!host) return;
  const mount = document.createElement('div');
  mount.className = 'view-mount';
  host.innerHTML = '';
  host.appendChild(mount);
  setHtml(mount, html`
    <div class="view">
      ${errorState({
        title: '无法加载仪表板数据',
        text: `${(error && error.message) || '请求失败'} · 接口 /api/dashboard`,
        retryLabel: '重新加载',
      })}
    </div>
  `);
  bindActions(mount, { retry: () => reloadDashboard() });
  currentView = null;
}

async function loadDashboard(options = {}) {
  const { keepScroll = true } = options;
  const state = getState();

  if (loadingInFlight) {
    queuedReload = true;
    return;
  }
  loadingInFlight = true;
  commit({ loading: true }, 'loading');
  if (!state.dashboard) renderSkeletonMount();
  else updateStatusStrip();

  try {
    const data = await api.dashboard(state.date);
    if (!data || !Array.isArray(data.models)) throw new Error('dashboard 响应格式异常');
    commit({
      dashboard: data,
      loading: false,
      error: null,
      updatedAt: Date.now(),
      today: data.today || state.today,
      upstreamBase: (data.config && data.config.base_url) || state.upstreamBase,
    }, 'dashboard');

    updateDatePicker();
    await renderView({ scroll: keepScroll ? 'keep' : 'top', route: parseHash() });
    updateChrome();
  } catch (error) {
    commit({ loading: false, error }, 'error');
    if (!getState().dashboard) {
      renderErrorMount(error);
      notifyError(error, { title: '数据加载失败' });
    } else {
      notifyError(error, { title: '数据刷新失败', retry: () => loadDashboard({ keepScroll: true }) });
    }
    updateChrome();
  } finally {
    loadingInFlight = false;
    if (queuedReload) {
      queuedReload = false;
      loadDashboard({ keepScroll: true });
    }
  }
}

function reloadDashboard() {
  return loadDashboard({ keepScroll: true });
}

/* ------------------------------- 路由 ------------------------------- */

function normalizeRoute(route) {
  const state = getState();
  const params = new URLSearchParams(route.params ? route.params.toString() : '');
  let changed = false;

  if (route.view === 'compare' && !params.get('models')) {
    const ids = state.compareModels || [];
    if (ids.length >= 2) {
      params.set('models', ids.join(','));
      changed = true;
    }
  }

  if (route.view === 'trend') {
    if (!params.get('model')) {
      const id = (state.trend && state.trend.model) || defaultModelId(state);
      if (id) {
        params.set('model', id);
        changed = true;
      }
    }
    if (!params.get('metric')) {
      params.set('metric', (state.trend && state.trend.metric) || 'ttft');
      changed = true;
    }
  }

  if (!changed) return route;
  const hash = hashFor(route.view, { id: route.id, params: paramsObject(params) });
  replaceHash(hash);
  return parseHash(hash);
}

function makeCtx(route) {
  const state = getState();
  return {
    state,
    route,
    upstreamBase: state.upstreamBase || shell.baseUrl || '',
    go: (view, options, opts) => navigate(view, options, opts),
    reload: (opts) => loadDashboard(opts || { keepScroll: true }),
    setDate: (date) => selectDate(date),
    runTest: () => triggerRun(),
    runModel: (id) => triggerRun(id),
    cancelRun: () => triggerCancel(),
    exportUrl: (modelId) => api.exportCsvUrl(resolvedDate(), modelId || ''),
    downloadCsv: (modelId) => exportCsv(modelId),
    syncUrl: (hash) => replaceHash(hash),
    hashFor,
    setCompareModels: (ids) => setCompareModels(ids),
    rememberCompare: (ids) => setCompareModels(ids),
    setTrend: (trend) => setTrend(trend),
    setRunLog: (list) => {
      commit({ runLog: Array.isArray(list) ? list : [], runLogUpdatedAt: Date.now() }, 'runlog');
      updateStatusStrip();
    },
    rememberModel: (id) => rememberModel(id),
    setAutoRefresh: (enabled) => setAutoRefresh(enabled),
    toast,
    notifyError,
  };
}

async function renderView(options = {}) {
  const state = getState();
  let route = options.route || parseHash();
  const scroll = options.scroll || 'keep';

  if (!state.dashboard) {
    if (state.error) renderErrorMount(state.error);
    else renderSkeletonMount();
    return;
  }

  route = normalizeRoute(route);
  const module = VIEW_MODULES[route.view] || overviewView;

  const previousY = window.scrollY;
  destroyCharts();
  if (currentView && typeof currentView.module.destroy === 'function') currentView.module.destroy();

  const host = document.getElementById('view-root');
  if (!host) return;
  const mount = document.createElement('div');
  mount.className = 'view-mount';
  host.innerHTML = '';
  host.appendChild(mount);

  const ctx = makeCtx(route);
  try {
    setHtml(mount, module.render(ctx));
  } catch (error) {
    console.error('[main] 视图渲染失败', error);
    setHtml(mount, html`
      <div class="view">
        ${errorState({
          title: '视图渲染失败',
          text: (error && error.message) || String(error),
        })}
      </div>
    `);
  }

  bindActions(mount, { ...commonActions(ctx) });
  if (typeof module.bind === 'function') module.bind(mount, ctx);
  currentView = { module, root: mount, ctx };

  if (typeof module.mount === 'function') {
    try {
      await module.mount(mount, ctx);
    } catch (error) {
      console.error('[main] 视图挂载失败', error);
      notifyError(error, { title: '视图初始化失败' });
    }
  }

  updateTabs(route);
  document.title = titleFor(route);

  if (scroll === 'top') scrollToTop();
  else window.scrollTo(0, previousY);
}

function titleFor(route) {
  const base = 'LLM 性能监控';
  switch (route.view) {
    case 'model':
      return `${route.id || '模型详情'} · ${base}`;
    case 'compare':
      return `多模型对比 · ${base}`;
    case 'trend':
      return `跨日期趋势 · ${base}`;
    case 'runs':
      return `运行记录 · ${base}`;
    default:
      return `${resolvedDate() || ''} 概览 · ${base}`.trim();
  }
}

async function handleRoute(route) {
  const date = routeDate(route);
  const state = getState();

  if (date !== state.date) {
    commit({ date }, 'route');
    await loadDashboard({ keepScroll: true });
    lastView = route.view;
    return;
  }

  if (route.view === 'model' && route.id) rememberModel(route.id);

  const scroll = lastView === route.view ? 'keep' : 'top';
  lastView = route.view;
  await renderView({ scroll, route });
  updateChrome();
}

/* ------------------------------- 交互动作 ------------------------------- */

function commonActions(ctx) {
  return {
    retry: () => loadDashboard({ keepScroll: true }),
    refresh: () => loadDashboard({ keepScroll: true }),
    'go-overview': () => navigate('overview', {}),
    'run-test': () => triggerRun(),
    'run-model': (el) => triggerRun(el.dataset.model),
    'cancel-run': () => triggerCancel(),
    'export-all': () => exportCsv(null),
    'export-model': () => exportCsv(currentModelId()),
    'chart-png': (el) => {
      const id = el.dataset.chart;
      const filename = el.dataset.filename || `${id}.png`;
      if (!exportChartPng(id, filename)) toast('图表尚未渲染完成，稍后再试', { type: 'warn' });
    },
    'add-compare': (el) => addToCompare(el.dataset.model),
  };
}

function setCompareModels(ids) {
  const list = Array.from(new Set((ids || []).filter(Boolean))).slice(0, MAX_COMPARE);
  commit({ compareModels: list }, 'compare');
  writePref(PREF.compareModels, list);
  updateTabs(parseHash());
}

function setTrend(trend) {
  const next = { ...(getState().trend || {}), ...(trend || {}) };
  commit({ trend: next }, 'trend');
  writePref(PREF.trendMetric, next.metric || 'ttft');
  writePref(PREF.trendModel, next.model || '');
  writePref(PREF.trendConcurrency, next.concurrency === '' ? '' : next.concurrency || '');
  writePref(PREF.trendRange, next.range || '7');
}

function rememberModel(id) {
  if (!id) return;
  const state = getState();
  const tab = document.getElementById('tab-model');
  const date = resolvedDate();
  if (tab) tab.setAttribute('href', hashFor('model', { id, params: { date } }));
  if (state.lastModel === id) return;
  commit({ lastModel: id }, 'model');
  writePref(PREF.lastModel, id);
}

function addToCompare(modelId) {
  if (!modelId) return;
  const state = getState();
  const list = state.compareModels.includes(modelId)
    ? state.compareModels
    : [...state.compareModels, modelId].slice(0, MAX_COMPARE);
  setCompareModels(list);
  toast(`已加入对比：${modelId}`, { type: 'success', duration: 2200 });
  navigate('compare', { params: { models: list.join(','), date: parseHash().date } });
}

function setAutoRefresh(enabled) {
  commit({ autoRefresh: Boolean(enabled) }, 'pref');
  writePref(PREF.autoRefresh, Boolean(enabled));
  if (!monitor) return;
  if (enabled) {
    if (isRunning(getState())) monitor.start();
  } else {
    monitor.stop();
    toast('已关闭自动刷新，可手动点击刷新', { type: 'info', duration: 2600 });
  }
}

function selectDate(date) {
  const route = parseHash();
  const params = paramsObject(route.params);
  const state = getState();
  const today = (state.dashboard && state.dashboard.today) || state.today || '';

  if (!date || date === today) delete params.date;
  else params.date = date;

  if (getState().date === (date && date !== today ? date : '')) {
    updateChrome();
    return;
  }
  navigate(route.view, { id: route.id, params }, { replace: true });
}

function exportCsv(modelId) {
  const date = resolvedDate();
  const url = api.exportCsvUrl(date, modelId || '');
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  toast(`已请求导出 ${date || '今天'} 的 CSV${modelId ? ` · ${modelId}` : ' · 全部模型'}`, {
    type: 'success',
    duration: 2600,
  });
}

async function triggerRun(modelId) {
  const state = getState();
  if (isRunning(state)) {
    toast('已有测试正在运行', { type: 'warn', detail: '请等待结束或先取消' });
    return;
  }
  if (runBusy) return;
  runBusy = true;
  updateStatusStrip();

  try {
    if (modelId) await api.runModel(modelId);
    else await api.runTest();
    toast(modelId ? `已启动 ${modelId} 的重测` : '已启动全量测试', { type: 'info', duration: 2600 });

    if (state.autoRefresh === false) {
      await monitor.syncNow();
    } else {
      monitor.start();
      await monitor.syncNow();
    }
    updateChrome();
    await loadDashboard({ keepScroll: true });
  } catch (error) {
    if (error && error.status === 409) {
      toast(error.message || '已有测试正在运行', { type: 'warn' });
    } else {
      notifyError(error, { title: '启动测试失败' });
    }
  } finally {
    runBusy = false;
    updateChrome();
  }
}

async function triggerCancel() {
  try {
    await api.cancel();
    toast('已请求取消，当前批次结束后停止', { type: 'warn' });
    if (getState().autoRefresh !== false) monitor.start();
    await monitor.syncNow();
    updateChrome();
  } catch (error) {
    if (error && error.status === 409) toast('当前没有正在运行的测试', { type: 'warn' });
    else notifyError(error, { title: '取消测试失败' });
  }
}

function handleStatus(status) {
  updateStatusStrip();
  if (currentView && typeof currentView.module.updateStatus === 'function') {
    currentView.module.updateStatus(currentView.root, status, currentView.ctx);
  }
}

async function handleRunFinished(status) {
  const last = status && status.last_run_status;
  if (last === 'success') {
    toast(status.message || '测试完成', { type: 'success', title: '测试完成' });
  } else if (String(last || '').startsWith('failed')) {
    notifyError(status.message || '测试失败', { title: '测试失败' });
  } else if (last === 'cancelled') {
    toast(status.message || '测试已取消', { type: 'warn', title: '测试已取消' });
  } else {
    toast(status && status.message ? status.message : '运行结束', { type: 'info' });
  }
  await loadDashboard({ keepScroll: true });
}

/* ------------------------------- 启动 ------------------------------- */

async function boot() {
  initTheme();
  updateThemeButton();
  onThemeChange(() => {
    updateThemeButton();
    refreshCharts();
  });

  bindHeader();
  monitor = createRunMonitor({
    onStatus: handleStatus,
    onFinished: handleRunFinished,
    onError: (error) => notifyError(error, { title: '运行状态轮询失败' }),
  });

  const route = parseHash();
  const date = routeDate(route);

  // history 页面：把服务端预置日期写进 hash，保证刷新/分享后仍然停在那一天
  if (!route.date && shell.date) {
    const params = paramsObject(route.params);
    params.date = shell.date;
    replaceHash(hashFor(route.view, { id: route.id, params }));
  }

  commit({ date }, 'init');
  initialRouteResolved = true;
  lastView = route.view;

  onRouteChange((next) => {
    handleRoute(next).catch((error) => {
      console.error('[main] 路由处理失败', error);
      notifyError(error, { title: '页面切换失败' });
    });
  });

  await loadDashboard({ keepScroll: false });

  if (!getState().dashboard) return;

  await monitor.boot();
  updateChrome();

  // 首次渲染后若服务端显示正在运行，确保进入轮询
  if (isRunning(getState()) && getState().autoRefresh !== false) monitor.start();
}

// 供调试 / 自动化验证使用（只读为主）
window.__HC__ = {
  get state() {
    return getState();
  },
  route: () => parseHash(),
  reload: () => reloadDashboard(),
  version: 'frontend-v2',
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((error) => {
      console.error('[main] 启动失败', error);
      renderErrorMount(error);
    });
  }, { once: true });
} else {
  boot().catch((error) => {
    console.error('[main] 启动失败', error);
    renderErrorMount(error);
  });
}

// 防止误用未使用变量告警（保留工具函数给调试场景）
void fmtMs;
void raw;
