// ---------------------------------------------------------------------------
// components/popover.js — 基于按钮的浮层（日期选择 / 导出菜单 / 多选）
// 键盘：Esc 关闭、外部点击关闭、打开时把焦点移入面板、关闭后回到触发按钮。
// ---------------------------------------------------------------------------

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function createPopover(options = {}) {
  const { trigger, panel, onOpen = null, onClose = null } = options;
  if (!trigger || !panel) {
    return { open() {}, close() {}, toggle() {}, isOpen: () => false, destroy() {} };
  }

  let open = false;

  const focusFirst = () => {
    const preferred = panel.querySelector('[data-autofocus]') || panel.querySelector(FOCUSABLE);
    if (preferred && typeof preferred.focus === 'function') {
      try {
        preferred.focus({ preventScroll: true });
      } catch (err) {
        preferred.focus();
      }
    }
  };

  const setOpen = (next) => {
    if (next === open) return;
    open = next;
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) {
      if (typeof onOpen === 'function') onOpen();
      focusFirst();
    } else {
      if (typeof onClose === 'function') onClose();
      try {
        trigger.focus({ preventScroll: true });
      } catch (err) {
        trigger.focus();
      }
    }
  };

  const onTriggerClick = (event) => {
    event.preventDefault();
    setOpen(!open);
  };

  const onDocumentPointer = (event) => {
    if (!open) return;
    if (panel.contains(event.target) || trigger.contains(event.target)) return;
    setOpen(false);
  };

  const onKeyDown = (event) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
    }
  };

  trigger.addEventListener('click', onTriggerClick);
  document.addEventListener('pointerdown', onDocumentPointer, true);
  document.addEventListener('keydown', onKeyDown, true);

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open,
    /** 面板内交互后主动收起 */
    closeAfter: () => setOpen(false),
    destroy() {
      trigger.removeEventListener('click', onTriggerClick);
      document.removeEventListener('pointerdown', onDocumentPointer, true);
      document.removeEventListener('keydown', onKeyDown, true);
    },
  };
}
