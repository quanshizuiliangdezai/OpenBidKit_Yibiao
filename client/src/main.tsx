import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AppProviders from './app/providers/AppProviders';
import WorkspaceDatabaseGate from './app/WorkspaceDatabaseGate';
import DeveloperTokenStatsWindow from './features/developer/pages/DeveloperTokenStatsWindow';
import './styles.css';

/**
 * 全局输入框焦点守卫。
 * Electron 在“窗口重获焦点 / 模态弹层出现 / 退出登录后重新弹门禁”等场景下，
 * 即使点击了 <input>/<textarea>/<select>，浏览器有时也不会把键盘焦点交给它，
 * 必须点一下外部再点回来才能输入。这里在 pointerdown 捕获阶段，对可编辑元素
 * 强制 focus()，确保任何页面、任何弹窗里的输入框都能直接输入。
 * 仅当目标并非当前活动元素时才聚焦，已聚焦的元素不会被重置选区，IME 不受影响。
 */
function installGlobalFocusGuard() {
  const isFocusable = (el: EventTarget | null): el is HTMLElement => {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const field = el as HTMLInputElement;
      return !field.readOnly && !field.disabled;
    }
    if (el.isContentEditable) return true;
    return false;
  };

  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target;
      if (isFocusable(target) && document.activeElement !== target) {
        (target as HTMLElement).focus();
      }
    },
    true,
  );
}

installGlobalFocusGuard();

const windowMode = new URLSearchParams(window.location.search).get('window');

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {windowMode === 'token-stats' ? (
      <DeveloperTokenStatsWindow />
    ) : (
      <AppProviders>
        <WorkspaceDatabaseGate>
          <App />
        </WorkspaceDatabaseGate>
      </AppProviders>
    )}
  </React.StrictMode>
);
