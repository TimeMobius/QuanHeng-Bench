// ---------------------------------------------------------------------------
// format.js — 数字/时间格式化（契约第 7 条）
// 千分位；TTFT ≥ 1000ms 显示为秒；token 用 k/M 缩写，精确值放 tooltip。
// ---------------------------------------------------------------------------

export const EMPTY = '—';

const intFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const decFmt = new Map();

function decimalFormatter(digits) {
  const key = String(digits);
  if (!decFmt.has(key)) {
    decFmt.set(key, new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }));
  }
  return decFmt.get(key);
}

export function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function toNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

/** 整数千分位：1234 → 1,234。 */
export function fmtInt(value) {
  const num = toNum(value);
  return num === null ? EMPTY : intFmt.format(Math.round(num));
}

/** 固定小数位 + 千分位：1234.567 → 1,234.6（digits=1）。 */
export function fmtFixed(value, digits = 1) {
  const num = toNum(value);
  return num === null ? EMPTY : decimalFormatter(digits).format(num);
}

/** 毫秒 → { value, unit }：812.3 → { value: '812', unit: 'ms' }；1234 → { value: '1.23', unit: 's' }。 */
export function msParts(value) {
  const num = toNum(value);
  if (num === null) return { value: EMPTY, unit: '' };
  if (Math.abs(num) >= 1000) {
    return { value: decimalFormatter(2).format(num / 1000), unit: 's' };
  }
  return { value: intFmt.format(Math.round(num)), unit: 'ms' };
}

/** 毫秒文本：812 ms / 1.23 s。 */
export function fmtMs(value) {
  const parts = msParts(value);
  return parts.unit ? `${parts.value} ${parts.unit}` : parts.value;
}

/** 毫秒精确值（tooltip 用）。 */
export function fmtMsExact(value) {
  const num = toNum(value);
  return num === null ? EMPTY : `${decimalFormatter(1).format(num)} ms`;
}

/** 速度：42.12 → { value: '42.1', unit: 't/s' }。 */
export function tpsParts(value) {
  const num = toNum(value);
  return num === null
    ? { value: EMPTY, unit: '' }
    : { value: decimalFormatter(1).format(num), unit: 't/s' };
}

export function fmtTps(value) {
  const parts = tpsParts(value);
  return parts.unit ? `${parts.value} ${parts.unit}` : parts.value;
}

/** token 缩写：84480 → { value: '84.5', unit: 'k', exact: '84,480' }。 */
export function tokenParts(value) {
  const num = toNum(value);
  if (num === null) return { value: EMPTY, unit: '', exact: EMPTY };
  const exact = intFmt.format(Math.round(num));
  const abs = Math.abs(num);
  if (abs >= 1_000_000) {
    return { value: decimalFormatter(2).format(num / 1_000_000), unit: 'M', exact };
  }
  if (abs >= 1000) {
    return { value: decimalFormatter(1).format(num / 1000), unit: 'k', exact };
  }
  return { value: intFmt.format(Math.round(num)), unit: '', exact };
}

export function fmtTokens(value) {
  const parts = tokenParts(value);
  return parts.unit ? `${parts.value} ${parts.unit}` : parts.value;
}

/** 百分比：99.5 → '99.5%'。 */
export function fmtPct(value, digits = 1) {
  const num = toNum(value);
  return num === null ? EMPTY : `${decimalFormatter(digits).format(num)}%`;
}

/** 秒 → 42 s / 12m 22s / 2h 03m。 */
export function fmtDuration(value) {
  const num = toNum(value);
  if (num === null) return EMPTY;
  const total = Math.max(0, Math.round(num));
  if (total < 60) return `${total} s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(secs).padStart(2, '0')}s`;
}

/** 'YYYY-MM-DD' → Date（本地日期，仅用于星期/比较）。 */
export function parseDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** '2026-08-27' → '2026-08-27 周四'。 */
export function fmtDateLabel(dateStr) {
  if (!dateStr) return EMPTY;
  const date = parseDate(dateStr);
  return date ? `${dateStr} ${WEEKDAYS[date.getDay()]}` : String(dateStr);
}

/** '2026-08-27' → '08-27'。 */
export function fmtDateShort(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  return match ? `${match[2]}-${match[3]}` : String(dateStr || EMPTY);
}

export function weekdayOf(dateStr) {
  const date = parseDate(dateStr);
  return date ? WEEKDAYS[date.getDay()] : '';
}

/** '2026-08-27 03:12:44' → '08-27 03:12'；只给时间时原样返回。 */
export function fmtDateTime(datetime) {
  const text = String(datetime || '').trim();
  if (!text) return EMPTY;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!match) return text;
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

/** '2026-08-27 03:12:44' → '03:12:44'。 */
export function fmtClock(datetime) {
  const text = String(datetime || '').trim();
  if (!text) return EMPTY;
  const match = /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!match) return text;
  return match[3] ? `${match[1]}:${match[2]}:${match[3]}` : `${match[1]}:${match[2]}`;
}

/** 相对时间：'刚刚' / '3 分钟前' / 具体时间。 */
export function fmtRelative(timestamp, now = Date.now()) {
  if (!timestamp) return EMPTY;
  const diff = Math.max(0, now - timestamp);
  if (diff < 15_000) return '刚刚';
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  const date = new Date(timestamp);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${fmtClock(`${date.getHours()}:${date.getMinutes()}`)}`;
}

/** 并发标签：8 → '×8'。 */
export function fmtConcurrency(value) {
  const num = toNum(value);
  return num === null ? EMPTY : `×${intFmt.format(num)}`;
}

/** 契约里的状态 → 中文标签 + 徽章类型。 */
export function statusInfo(status) {
  switch (status) {
    case 'good': return { label: '良好', tone: 'good' };
    case 'warn': return { label: '有波动', tone: 'warn' };
    case 'bad': return { label: '异常', tone: 'bad' };
    case 'none': return { label: '未测试', tone: 'none' };
    default: return { label: String(status || '未知'), tone: 'none' };
  }
}

/** 运行状态 → 中文。 */
export function runStatusInfo(status) {
  const text = String(status || '');
  if (text === 'success') return { label: '成功', tone: 'good' };
  if (text === 'running') return { label: '运行中', tone: 'running' };
  if (text === 'cancelled') return { label: '已取消', tone: 'warn' };
  if (text.startsWith('failed')) return { label: '失败', tone: 'bad', detail: text.replace(/^failed:\s*/, '') };
  if (!text) return { label: '未知', tone: 'none' };
  return { label: text, tone: 'none' };
}

/** 判别成功率（用于进度条颜色）。 */
export function rateTone(value) {
  const num = toNum(value);
  if (num === null) return '';
  if (num >= 99) return '';
  if (num >= 80) return 'rate--warn';
  return 'rate--bad';
}
