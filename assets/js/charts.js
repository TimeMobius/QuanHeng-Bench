// ---------------------------------------------------------------------------
// charts.js — Chart.js 封装
//   · 颜色全部读 CSS 变量（深色模式切换后 refreshCharts() 重绘）
//   · 并发轴用等距 category 轴 + 真实并发标签（1,2,4,8…）
//   · 单位不混轴：TTFT(ms) 用左轴，吞吐(t/s) 用右轴
//   · 每张图可 toBase64Image() 导出 PNG
// ---------------------------------------------------------------------------

import { cssVar } from './dom.js';
import { fmtMs, fmtTps, fmtPct, fmtConcurrency, fmtInt, fmtFixed } from './format.js';

const registry = new Map();
let loaderPromise = null;

/** 趋势指标元数据（趋势视图与图表共用）。 */
export const TREND_METRICS = [
  { key: 'ttft', label: '平均 TTFT', unit: 'ms' },
  { key: 'p50', label: 'P50 延迟', unit: 'ms' },
  { key: 'p95', label: 'P95 延迟', unit: 'ms' },
  { key: 'p99', label: 'P99 延迟', unit: 'ms' },
  { key: 'tps', label: '整体吞吐', unit: 'tps' },
  { key: 'output', label: '输出速度', unit: 'tps' },
  { key: 'success', label: '成功率', unit: 'pct' },
];

export const METRIC_BY_KEY = Object.fromEntries(TREND_METRICS.map((metric) => [metric.key, metric]));

/* ------------------------------ 主题 & 工具 ------------------------------ */

export function readTheme() {
  const palette = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6']
    .map((name, index) => cssVar(name, ['#5b5bd6', '#0d9aa8', '#d9871a', '#d94f6f', '#7c63d8', '#3d8f59'][index]));
  return {
    font: cssVar('--font-sans', 'system-ui, sans-serif'),
    text: cssVar('--text', '#16202f'),
    muted: cssVar('--text-muted', '#586279'),
    faint: cssVar('--text-faint', '#8792a7'),
    grid: cssVar('--chart-grid', 'rgba(22,32,47,.09)'),
    surface: cssVar('--chart-surface', '#ffffff'),
    palette,
  };
}

export function colorFor(theme, index) {
  return theme.palette[index % theme.palette.length];
}

function withAlpha(color, alpha) {
  const hex = String(color || '').trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  const full = short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : hex;
  const match = /^#([0-9a-f]{6})$/i.exec(full);
  if (!match) return full;
  const suffix = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return `${full}${suffix}`;
}

function compactNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const abs = Math.abs(num);
  if (abs >= 1_000_000) return `${fmtFixed(num / 1_000_000, 1)}M`;
  if (abs >= 1000) return `${fmtFixed(num / 1000, 1)}k`;
  return fmtInt(num);
}

export function unitFormatter(unit) {
  switch (unit) {
    case 'ms': return (value) => fmtMs(value);
    case 'tps': return (value) => fmtTps(value);
    case 'pct': return (value) => fmtPct(value);
    case 'tokens': return (value) => fmtInt(value);
    case 'count': return (value) => fmtInt(value);
    default: return (value) => fmtFixed(value, 2);
  }
}

/** 图表库就绪（本地 UMD，不引 CDN）。 */
export function chartLibraryReady() {
  if (window.Chart) return Promise.resolve(window.Chart);
  if (!loaderPromise) {
    loaderPromise = new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (window.Chart) {
          resolve(window.Chart);
          return;
        }
        if (Date.now() - started > 10_000) {
          reject(new Error('Chart.js 未加载（/assets/vendor/chart.js/chart.umd.min.js）'));
          return;
        }
        window.setTimeout(poll, 60);
      };
      poll();
    });
  }
  return loaderPromise;
}

export function chartAvailable() {
  return Boolean(window.Chart);
}

/* ------------------------------ 配置工厂 ------------------------------ */

function baseOptions(theme) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 6, right: 8, bottom: 0, left: 0 } },
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        align: 'start',
        labels: {
          color: theme.muted,
          usePointStyle: true,
          pointStyle: 'circle',
          boxWidth: 7,
          boxHeight: 7,
          padding: 14,
          font: { size: 11, family: theme.font },
        },
      },
      tooltip: {
        backgroundColor: theme.surface,
        titleColor: theme.text,
        bodyColor: theme.muted,
        borderColor: theme.grid,
        borderWidth: 1,
        cornerRadius: 8,
        padding: 10,
        boxPadding: 4,
        usePointStyle: true,
        titleFont: { size: 12, family: theme.font, weight: '600' },
        bodyFont: { size: 12, family: theme.font },
        callbacks: {},
      },
    },
  };
}

function tooltipCallbacks(theme) {
  return {
    label(context) {
      const dataset = context.dataset || {};
      const unit = dataset.hcUnit || '';
      const parsed = context.parsed;
      let value = parsed;
      if (parsed && typeof parsed === 'object') {
        value = context.chart.options.indexAxis === 'y' ? parsed.x : parsed.y;
      }
      const format = unitFormatter(unit);
      const prefix = dataset.label ? `${dataset.label}: ` : '';
      return `${prefix}${format(value)}`;
    },
    title(items) {
      if (!items || !items.length) return '';
      const item = items[0];
      if (item.dataset && item.dataset.hcTitle) return item.dataset.hcTitle;
      return String(item.label || '');
    },
  };
}

function categoryScale(theme, labels, title) {
  return {
    type: 'category',
    labels,
    grid: { display: false, drawTicks: false },
    border: { color: theme.grid },
    title: title
      ? { display: true, text: title, color: theme.faint, font: { size: 11, family: theme.font } }
      : { display: false },
    ticks: {
      color: theme.muted,
      font: { size: 11, family: theme.font },
      padding: 6,
      autoSkip: false,
      maxRotation: 0,
      minRotation: 0,
    },
  };
}

function valueScale(theme, options = {}) {
  const {
    position = 'left',
    title = '',
    showGrid = position === 'left',
    min,
    max,
    tickFormatter = compactNumber,
    beginAtZero = true,
    type = 'linear',
  } = options;
  return {
    type,
    position,
    beginAtZero: type === 'logarithmic' ? false : beginAtZero,
    min,
    max,
    grid: {
      display: true,
      color: theme.grid,
      drawTicks: false,
      drawOnChartArea: showGrid,
      lineWidth: 1,
    },
    border: { display: false },
    title: title
      ? { display: true, text: title, color: theme.faint, font: { size: 11, family: theme.font } }
      : { display: false },
    ticks: {
      color: theme.muted,
      font: { size: 11, family: theme.font },
      padding: 6,
      maxTicksLimit: 6,
      callback: tickFormatter,
    },
  };
}

function logScale(theme, options = {}) {
  return valueScale(theme, { ...options, type: 'logarithmic' });
}

/** 并发跨越过大（最高/最低 ≥ 20 倍）时，TTFT 折线改用对数 Y 轴，低并发段才看得清。 */
export function ttftUsesLogAxis(rows) {
  const values = [];
  rows.forEach((row) => {
    ['avg_ttft_ms', 'p50_ttft_ms', 'p95_ttft_ms', 'p99_ttft_ms'].forEach((key) => {
      const value = Number(row[key]);
      if (Number.isFinite(value) && value > 0) values.push(value);
    });
  });
  if (values.length < 2) return false;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min > 0 && max / min >= 20;
}

function lineDataset(options) {
  const {
    label,
    data,
    color,
    dash = [],
    fill = false,
    showPoints = true,
    unit = '',
    axis = 'y',
    width,
    title = '',
  } = options;
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: fill ? withAlpha(color, 0.16) : color,
    borderWidth: width || (fill ? 2.4 : 1.8),
    borderDash: dash,
    fill: fill ? 'origin' : false,
    tension: 0.32,
    pointRadius: showPoints ? 3.4 : 0,
    pointHoverRadius: 5,
    pointBackgroundColor: color,
    pointBorderColor: color,
    pointBorderWidth: 0,
    yAxisID: axis,
    hcUnit: unit,
    hcTitle: title,
  };
}

function barDataset(options) {
  const {
    label,
    data,
    color,
    unit = '',
    axis = 'y',
    alpha = 0.85,
    stack,
  } = options;
  return {
    label,
    data,
    backgroundColor: withAlpha(color, alpha),
    hoverBackgroundColor: color,
    borderColor: color,
    borderWidth: 0,
    borderRadius: 5,
    maxBarThickness: 26,
    yAxisID: axis,
    stack,
    hcUnit: unit,
  };
}

function backgroundPlugin(color) {
  return {
    id: 'hcBackground',
    beforeDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, chart.width, chart.height);
      ctx.restore();
    },
  };
}

function finalize(theme, config, scales, tooltip) {
  const options = baseOptions(theme);
  options.plugins.tooltip.callbacks = tooltipCallbacks(theme);
  if (tooltip) options.plugins.tooltip.callbacks = { ...options.plugins.tooltip.callbacks, ...tooltip };
  options.scales = scales;
  config.options = options;
  config.plugins = [backgroundPlugin(theme.surface)];
  return config;
}

/* ------------------------------ 预设图表 ------------------------------ */

/** 模型详情：TTFT + 分位（avg / P50 / P95 / P99）。 */
export function ttftPreset(rows, theme) {
  const labels = rows.map((row) => fmtConcurrency(row.concurrency));
  const series = [
    lineDataset({ label: '平均 TTFT', data: rows.map((r) => r.avg_ttft_ms), color: colorFor(theme, 0), fill: true, unit: 'ms' }),
    lineDataset({ label: 'P50', data: rows.map((r) => r.p50_ttft_ms), color: colorFor(theme, 1), dash: [6, 3], unit: 'ms', showPoints: false }),
    lineDataset({ label: 'P95', data: rows.map((r) => r.p95_ttft_ms), color: colorFor(theme, 2), dash: [6, 3], unit: 'ms', showPoints: false }),
    lineDataset({ label: 'P99', data: rows.map((r) => r.p99_ttft_ms), color: colorFor(theme, 3), dash: [2, 3], unit: 'ms', showPoints: false }),
  ];
  const yScale = ttftUsesLogAxis(rows)
    ? logScale(theme, { title: 'TTFT (ms) · 对数轴' })
    : valueScale(theme, { title: 'TTFT (ms)', tickFormatter: compactNumber });

  return finalize(theme, { type: 'line', data: { labels, datasets: series } }, {
    x: categoryScale(theme, labels, '并发'),
    y: yScale,
  });
}

/** 模型详情：吞吐双 Y 轴（输出速度 / 整体吞吐）。 */
export function throughputPreset(rows, theme) {
  const labels = rows.map((row) => fmtConcurrency(row.concurrency));
  const series = [
    lineDataset({ label: '输出速度 (t/s)', data: rows.map((r) => r.avg_output_speed_tps), color: colorFor(theme, 1), fill: true, unit: 'tps', axis: 'y' }),
    lineDataset({ label: '整体吞吐 (t/s)', data: rows.map((r) => r.avg_tps), color: colorFor(theme, 0), dash: [6, 3], unit: 'tps', axis: 'y1' }),
  ];
  return finalize(theme, { type: 'line', data: { labels, datasets: series } }, {
    x: categoryScale(theme, labels, '并发'),
    y: valueScale(theme, { title: '输出速度 (t/s)' }),
    y1: valueScale(theme, { position: 'right', title: '整体吞吐 (t/s)', showGrid: false }),
  });
}

/** 模型详情：成功率折线（0–100）。 */
export function successPreset(rows, theme) {
  const labels = rows.map((row) => fmtConcurrency(row.concurrency));
  const series = [
    lineDataset({ label: '成功率', data: rows.map((r) => r.success_rate), color: colorFor(theme, 5), fill: true, unit: 'pct' }),
  ];
  return finalize(theme, { type: 'line', data: { labels, datasets: series } }, {
    x: categoryScale(theme, labels, '并发'),
    y: valueScale(theme, {
      title: '成功率 (%)',
      min: 0,
      max: 100,
      tickFormatter: (value) => `${fmtInt(value)}%`,
    }),
  });
}

/** 模型详情：综合柱状图（TTFT 左轴 ms，吞吐/输出速度右轴 t/s）。 */
export function compositePreset(rows, theme) {
  const labels = rows.map((row) => fmtConcurrency(row.concurrency));
  const series = [
    barDataset({ label: 'TTFT (ms)', data: rows.map((r) => r.avg_ttft_ms), color: colorFor(theme, 0), unit: 'ms', axis: 'y' }),
    barDataset({ label: '输出速度 (t/s)', data: rows.map((r) => r.avg_output_speed_tps), color: colorFor(theme, 1), unit: 'tps', axis: 'y1' }),
    barDataset({ label: '整体吞吐 (t/s)', data: rows.map((r) => r.avg_tps), color: colorFor(theme, 2), unit: 'tps', axis: 'y1' }),
  ];
  return finalize(theme, { type: 'bar', data: { labels, datasets: series } }, {
    x: categoryScale(theme, labels, '并发'),
    y: valueScale(theme, { title: 'TTFT (ms)' }),
    y1: valueScale(theme, { position: 'right', title: '吞吐 (t/s)', showGrid: false }),
  });
}

/** 概览：各模型平均 TTFT 横向柱状图。 */
export function modelsBarPreset(models, theme) {
  const usable = models.filter((model) => model.summary && Number.isFinite(model.summary.avg_ttft_ms));
  const labels = usable.map((model) => (model.id.length > 22 ? `${model.id.slice(0, 21)}…` : model.id));
  const colors = usable.map((model, index) => (model.status === 'good'
    ? withAlpha(colorFor(theme, 0), 0.9)
    : model.status === 'warn'
      ? withAlpha(colorFor(theme, 2), 0.9)
      : model.status === 'bad'
        ? withAlpha(colorFor(theme, 3), 0.9)
        : withAlpha(colorFor(theme, 4), 0.55)));
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '平均 TTFT (ms)',
        data: usable.map((model) => model.summary.avg_ttft_ms),
        backgroundColor: colors,
        borderRadius: 5,
        maxBarThickness: 22,
        hcUnit: 'ms',
      }],
    },
  };
  const options = baseOptions(theme);
  options.indexAxis = 'y';
  options.plugins.legend.display = false;
  options.plugins.tooltip.callbacks = tooltipCallbacks(theme);
  options.scales = {
    x: valueScale(theme, { title: '平均 TTFT (ms)', showGrid: true }),
    y: {
      type: 'category',
      labels,
      grid: { display: false },
      border: { display: false },
      ticks: { color: theme.muted, font: { size: 11, family: theme.font }, padding: 4 },
    },
  };
  config.options = options;
  config.plugins = [backgroundPlugin(theme.surface)];
  return config;
}

/** 对比：TTFT（左轴 ms，实线）叠加输出速度（右轴 t/s，虚线），每个模型一色。 */
export function compareOverlayPreset(entries, theme) {
  const levels = [];
  entries.forEach((entry) => {
    entry.records.forEach((record) => {
      if (!levels.includes(record.concurrency)) levels.push(record.concurrency);
    });
  });
  levels.sort((a, b) => a - b);
  const labels = levels.map((level) => fmtConcurrency(level));

  const datasets = [];
  entries.forEach((entry, index) => {
    const color = colorFor(theme, index);
    const byLevel = new Map(entry.records.map((record) => [record.concurrency, record]));
    datasets.push(lineDataset({
      label: `${entry.model} · TTFT`,
      data: levels.map((level) => (byLevel.has(level) ? byLevel.get(level).avg_ttft_ms : null)),
      color,
      fill: false,
      unit: 'ms',
      axis: 'y',
      title: entry.model,
    }));
    datasets.push(lineDataset({
      label: `${entry.model} · 输出速度`,
      data: levels.map((level) => (byLevel.has(level) ? byLevel.get(level).avg_output_speed_tps : null)),
      color,
      dash: [5, 4],
      showPoints: false,
      unit: 'tps',
      axis: 'y1',
      title: entry.model,
    }));
  });

  return finalize(theme, { type: 'line', data: { labels, datasets } }, {
    x: categoryScale(theme, labels, '并发'),
    y: valueScale(theme, { title: 'TTFT (ms)' }),
    y1: valueScale(theme, { position: 'right', title: '输出速度 (t/s)', showGrid: false }),
  });
}

/** 对比：成功率（0–100）多模型叠加。 */
export function compareSuccessPreset(entries, theme) {
  const levels = [];
  entries.forEach((entry) => entry.records.forEach((record) => {
    if (!levels.includes(record.concurrency)) levels.push(record.concurrency);
  }));
  levels.sort((a, b) => a - b);
  const labels = levels.map((level) => fmtConcurrency(level));
  const datasets = entries.map((entry, index) => {
    const byLevel = new Map(entry.records.map((record) => [record.concurrency, record]));
    return lineDataset({
      label: entry.model,
      data: levels.map((level) => (byLevel.has(level) ? byLevel.get(level).success_rate : null)),
      color: colorFor(theme, index),
      unit: 'pct',
    });
  });
  return finalize(theme, { type: 'line', data: { labels, datasets } }, {
    x: categoryScale(theme, labels, '并发'),
    y: valueScale(theme, { title: '成功率 (%)', min: 0, max: 100, tickFormatter: (value) => `${fmtInt(value)}%` }),
  });
}

/** 对比：归一化雷达图（0–100，越高越好；TTFT 已取倒数归一）。 */
export function radarPreset(labels, series, theme) {
  const datasets = series.map((item, index) => {
    const color = colorFor(theme, index);
    return {
      label: item.label,
      data: item.data,
      borderColor: color,
      backgroundColor: withAlpha(color, 0.16),
      borderWidth: 2,
      pointBackgroundColor: color,
      pointRadius: 3,
      fill: true,
    };
  });
  const options = baseOptions(theme);
  options.plugins.tooltip.callbacks = {
    label(context) {
      const value = context.parsed && context.parsed.r;
      return `${context.dataset.label}: ${fmtFixed(value, 1)} / 100`;
    },
  };
  options.scales = {
    r: {
      min: 0,
      max: 100,
      angleLines: { color: theme.grid },
      grid: { color: theme.grid },
      pointLabels: { color: theme.muted, font: { size: 11, family: theme.font } },
      ticks: { display: false, stepSize: 25 },
    },
  };
  return {
    type: 'radar',
    data: { labels, datasets },
    options,
    plugins: [backgroundPlugin(theme.surface)],
  };
}

/** 趋势：跨日期折线。 */
export function trendPreset(points, metricKey, theme) {
  const metric = METRIC_BY_KEY[metricKey] || METRIC_BY_KEY.ttft;
  const labels = points.map((point) => point.date.slice(5));
  const isPct = metric.unit === 'pct';
  const dataset = lineDataset({
    label: metric.label,
    data: points.map((point) => point.value),
    color: colorFor(theme, 0),
    fill: true,
    unit: metric.unit,
    title: points.map((point) => `${point.date} · ${fmtInt(point.request_count)} 请求`),
  });
  const scales = {
    x: categoryScale(theme, labels, '日期'),
    y: isPct
      ? valueScale(theme, { title: `${metric.label} (%)`, min: 0, max: 100, tickFormatter: (value) => `${fmtInt(value)}%` })
      : valueScale(theme, { title: `${metric.label}${metric.unit === 'ms' ? ' (ms)' : ' (t/s)'}` }),
  };
  return finalize(theme, { type: 'line', data: { labels, datasets: [dataset] } }, scales);
}

/* ------------------------------ 生命周期 ------------------------------ */

function destroyEntry(entry) {
  if (!entry) return;
  if (entry.chart) {
    try {
      entry.chart.destroy();
    } catch (err) {
      /* 忽略销毁异常 */
    }
    entry.chart = null;
  }
}

async function renderEntry(entry) {
  try {
    const Chart = await chartLibraryReady();
    if (registry.get(entry.id) !== entry) return;
    const theme = readTheme();

    Chart.defaults.color = theme.muted;
    Chart.defaults.font.family = theme.font;
    Chart.defaults.font.size = 11;
    Chart.defaults.borderColor = theme.grid;
    Chart.defaults.animation = false;

    const config = entry.build(theme);
    if (!config) return;
    destroyEntry(entry);
    entry.chart = new Chart(entry.canvas.getContext('2d'), config);
  } catch (err) {
    console.error('[charts] 渲染失败', err);
  }
}

/**
 * 挂载图表：build(theme) → Chart 配置。
 * 重复调用同一个 id 会替换旧实例（视图重渲染时安全）。
 */
export function mountChart(id, build) {
  if (typeof build !== 'function') return;
  const canvas = document.getElementById(`chart-${id}`);
  if (!canvas) return;

  const existing = registry.get(id);
  if (existing) {
    destroyEntry(existing);
    registry.delete(id);
  }
  const entry = { id, canvas, build, chart: null };
  registry.set(id, entry);
  renderEntry(entry);
}

export function destroyCharts() {
  registry.forEach((entry) => destroyEntry(entry));
  registry.clear();
}

/** 主题切换后重绘所有存活图表。 */
export function refreshCharts() {
  registry.forEach((entry) => {
    if (!entry.canvas || !entry.canvas.isConnected) return;
    renderEntry(entry);
  });
}

export function hasChart(id) {
  const entry = registry.get(id);
  return Boolean(entry && entry.chart);
}

/** 导出 PNG（chart.toBase64Image）。 */
export function exportChartPng(id, filename = 'chart.png') {
  const entry = registry.get(id);
  if (!entry || !entry.chart) return false;
  try {
    const url = entry.chart.toBase64Image('image/png', 1);
    if (!url) return false;
    const link = document.createElement('a');
    link.href = url;
    link.download = filename.replace(/[\\/:*?"<>|]+/g, '_');
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  } catch (err) {
    console.error('[charts] 导出失败', err);
    return false;
  }
}
