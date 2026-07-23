import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../shared/ui';

interface CheckUpdateResult {
  enabled?: boolean;
  updateAvailable?: boolean;
  version?: string;
  downloaded?: boolean;
  failed?: boolean;
  message?: string;
  channel?: string;
}

function TopBar() {
  const { showToast } = useToast();
  const [checking, setChecking] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined' || !window.yibiao?.getVersion) return;
    window.yibiao.getVersion()
      .then((v) => setAppVersion(String(v || '').replace(/^v/, '')))
      .catch(() => undefined);
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    if (checking) return;
    if (typeof window === 'undefined' || !window.yibiao?.checkUpdate) {
      showToast('当前环境不支持在线更新检查', 'error');
      return;
    }
    setChecking(true);
    try {
      const result = (await window.yibiao.checkUpdate()) as CheckUpdateResult | null;
      if (!result) {
        showToast('未获取到更新信息', 'error');
        return;
      }
      if (result.enabled === false) {
        showToast('开发环境暂不检查更新，正式版可用', 'info');
        return;
      }
      if (result.failed) {
        showToast(result.message || '检查更新失败，请稍后再试', 'error');
        return;
      }
      if (result.updateAvailable && result.downloaded) {
        showToast(`新版本 ${result.version || ''} 已下载完成，退出后自动安装`, 'success', {
          duration: 7000,
          actions: [
            {
              label: '立即安装',
              variant: 'primary',
              onClick: async () => {
                try {
                  await window.yibiao?.quitAndInstall?.();
                } catch (error) {
                  showToast(error instanceof Error ? error.message : '启动安装失败', 'error');
                }
              },
            },
          ],
        });
        return;
      }
      if (result.updateAvailable && result.version) {
        showToast(`发现新版本 ${result.version}，正在下载…`, 'info', { duration: 5000 });
        return;
      }
      showToast('当前已是最新版本', 'success', { duration: 3000 });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '检查更新失败', 'error');
    } finally {
      setChecking(false);
    }
  }, [checking, showToast]);

  return (
    <div className="app-topbar" role="banner">
      <div className="app-topbar-spacer" />
      <div className="app-topbar-actions">
        {appVersion ? <span className="app-topbar-version" title="当前应用版本">v{appVersion}</span> : null}
        <button
          type="button"
          className="app-topbar-update-btn"
          onClick={() => void handleCheckUpdate()}
          disabled={checking}
          aria-label="检查更新"
        >
          <span className="app-topbar-update-icon" aria-hidden="true">
            <RefreshIcon className={checking ? 'is-spinning' : ''} />
          </span>
          <span className="app-topbar-update-label">{checking ? '检查中…' : '检查更新'}</span>
        </button>
      </div>
    </div>
  );
}

function RefreshIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 1 0-2.34 5.66" />
      <path d="M20 4v6h-6" />
    </svg>
  );
}

export default TopBar;
