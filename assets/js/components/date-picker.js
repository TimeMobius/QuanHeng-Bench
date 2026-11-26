// ---------------------------------------------------------------------------
// components/date-picker.js — 全局日期选择器（可搜索、键盘可用）
// ---------------------------------------------------------------------------

import { html, raw, setHtml } from '../dom.js';
import { fmtDateLabel, fmtDateShort, weekdayOf } from '../format.js';

export function createDatePicker(options) {
  const {
    panel,
    searchInput,
    list,
    hint,
    onSelect,
    closePanel,
  } = options;

  let dates = [];
  let selected = '';
  let today = '';
  let focusedIndex = -1;
  let filtered = [];

  function updateHint() {
    if (!hint) return;
    const total = dates.length;
    const shown = filtered.length;
    if (!total) {
      hint.textContent = '暂无历史日期';
    } else if (shown !== total) {
      hint.textContent = `匹配 ${shown} / 共 ${total} 个日期`;
    } else {
      hint.textContent = `共 ${total} 个日期`;
    }
  }

  function items() {
    return list ? Array.prototype.slice.call(list.querySelectorAll('.date-item')) : [];
  }

  function focusItem(index) {
    const nodes = items();
    if (!nodes.length) return;
    focusedIndex = Math.max(0, Math.min(nodes.length - 1, index));
    nodes.forEach((node, i) => {
      node.classList.toggle('is-focused', i === focusedIndex);
      node.tabIndex = i === focusedIndex ? 0 : -1;
    });
    try {
      nodes[focusedIndex].focus({ preventScroll: true });
    } catch (err) {
      nodes[focusedIndex].focus();
    }
  }

  function render() {
    if (!list) return;
    const keyword = String((searchInput && searchInput.value) || '').trim();
    filtered = dates.filter((date) => {
      if (!keyword) return true;
      const haystack = `${date} ${fmtDateLabel(date)} ${fmtDateShort(date)} ${weekdayOf(date)}`;
      return haystack.includes(keyword);
    });

    if (!filtered.length) {
      setHtml(list, html`<p class="date-empty">${dates.length ? '没有匹配的日期' : '暂无历史日期'}</p>`);
      focusedIndex = -1;
      updateHint();
      return;
    }

    if (focusedIndex < 0 || focusedIndex >= filtered.length) {
      const selectedIndex = filtered.indexOf(selected);
      focusedIndex = selectedIndex >= 0 ? selectedIndex : 0;
    }

    setHtml(list, html`${filtered.map((date, index) => html`
      <button class="date-item${index === focusedIndex ? ' is-focused' : ''}" type="button" role="option"
              data-date="${date}" aria-selected="${date === selected ? 'true' : 'false'}"
              tabindex="${index === focusedIndex ? '0' : '-1'}">
        <span class="date-item__date">${date}</span>
        <span class="date-item__dow">${weekdayOf(date)}</span>
        ${date === today ? html`<span class="badge badge--outline date-item__tag">今天</span>` : raw('')}
      </button>`)}`);
    updateHint();
  }

  function setData(next = {}) {
    if (Array.isArray(next.dates)) dates = next.dates.slice();
    if (typeof next.selected === 'string') selected = next.selected;
    if (typeof next.today === 'string') today = next.today;
    if (searchInput && searchInput.value) searchInput.value = '';
    focusedIndex = -1;
    render();
  }

  function choose(date) {
    if (!date) return;
    if (typeof onSelect === 'function') onSelect(date);
    if (typeof closePanel === 'function') closePanel();
  }

  const onListClick = (event) => {
    const button = event.target.closest('.date-item');
    if (!button) return;
    choose(button.dataset.date);
  };

  const onSearchInput = () => {
    focusedIndex = -1;
    render();
  };

  const onSearchKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(focusedIndex < 0 ? 0 : focusedIndex + 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = filtered[focusedIndex] || filtered[0];
      choose(target);
    }
  };

  const onListKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(focusedIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (focusedIndex <= 0 && searchInput) {
        searchInput.focus();
        return;
      }
      focusItem(focusedIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(items().length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const button = event.target.closest('.date-item');
      if (button) choose(button.dataset.date);
    }
  };

  list.addEventListener('click', onListClick);
  list.addEventListener('keydown', onListKeyDown);
  if (searchInput) {
    searchInput.addEventListener('input', onSearchInput);
    searchInput.addEventListener('keydown', onSearchKeyDown);
  }

  return {
    setData,
    refresh: render,
    focusSearch() {
      if (searchInput) searchInput.focus();
    },
    reset() {
      if (searchInput) searchInput.value = '';
      focusedIndex = -1;
      render();
    },
    destroy() {
      list.removeEventListener('click', onListClick);
      list.removeEventListener('keydown', onListKeyDown);
      if (searchInput) {
        searchInput.removeEventListener('input', onSearchInput);
        searchInput.removeEventListener('keydown', onSearchKeyDown);
      }
    },
  };
}
