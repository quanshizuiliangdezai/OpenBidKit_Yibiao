import { useEffect, useState } from 'react';

function TopBar() {
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined' || !window.yibiao?.getVersion) return;
    window.yibiao.getVersion()
      .then((v) => setAppVersion(String(v || '').replace(/^v/, '')))
      .catch(() => undefined);
  }, []);

  return (
    <div className="app-topbar" role="banner">
      <div className="app-topbar-spacer" />
      <div className="app-topbar-actions">
        {appVersion ? <span className="app-topbar-version" title="当前应用版本">v{appVersion}</span> : null}
      </div>
    </div>
  );
}

export default TopBar;
