// ---------------------------------------------------------------------------
// components/run-monitor.js — 运行状态轮询（默认开，2s，仅运行中）
// 运行结束 → 通知 main 拉一次 /api/dashboard 重渲染（绝不整页 reload）。
// ---------------------------------------------------------------------------

import { api } from '../api.js';
import { getState, commit } from '../store.js';

export const POLL_INTERVAL_MS = 2000;

export function createRunMonitor(options = {}) {
  const { onStatus = null, onFinished = null, onError = null } = options;

  let timer = null;
  let polling = false;
  let inFlight = false;
  let failures = 0;
  let lastRunning = Boolean((getState().status || {}).running);

  function clearTimer() {
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delay = POLL_INTERVAL_MS) {
    if (!polling) return;
    if (timer) return;
    const hidden = document.visibilityState === 'hidden';
    timer = window.setTimeout(() => {
      timer = null;
      tick();
    }, hidden ? Math.max(delay, 5000) : delay);
  }

  async function tick() {
    if (inFlight) {
      schedule();
      return;
    }
    inFlight = true;
    try {
      const status = await api.status();
      failures = 0;
      apply(status);
    } catch (err) {
      failures += 1;
      if (failures === 3 && typeof onError === 'function') onError(err);
    } finally {
      inFlight = false;
      if (polling) schedule();
    }
  }

  /** 收到新状态：广播 + 判断 running→idle 的完成瞬间。 */
  function apply(status) {
    if (!status || typeof status !== 'object') return;
    const wasRunning = lastRunning;
    lastRunning = Boolean(status.running);
    commit({ status }, 'status');
    if (typeof onStatus === 'function') onStatus(status);

    if (wasRunning && !lastRunning) {
      stop();
      if (typeof onFinished === 'function') onFinished(status);
    } else if (!lastRunning && polling) {
      stop();
    }
  }

  function start() {
    if (polling) return;
    polling = true;
    clearTimer();
    tick();
  }

  function stop() {
    polling = false;
    clearTimer();
  }

  /** 主动同步一次（触发运行后立即刷新，不等 2s）。 */
  async function syncNow() {
    const status = await api.status();
    failures = 0;
    apply(status);
    return status;
  }

  /** 页面初始化：运行中则开始轮询，否则只记下状态。 */
  async function boot() {
    try {
      const status = await api.status();
      failures = 0;
      apply(status);
      if (status && status.running) start();
      return status;
    } catch (err) {
      if (typeof onError === 'function') onError(err);
      return null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!polling) return;
    if (document.visibilityState === 'visible') {
      clearTimer();
      tick();
    }
  });

  return {
    boot,
    start,
    stop,
    syncNow,
    apply,
    isPolling: () => polling,
    isRunning: () => lastRunning,
  };
}
