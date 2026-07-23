import { useEffect, useRef, useState } from 'react';
import AppRouter from './app/AppRouter';
import { getAppMenuItems } from './app/menuConfig';
import GpuHardwareAccelerationPrompt from './app/GpuHardwareAccelerationPrompt';
import LicenseStatusPrompt from './app/LicenseStatusPrompt';
import RequiredOnlineServicesPrompt from './app/RequiredOnlineServicesPrompt';
import UpdateNotifier from './app/UpdateNotifier';
import AppShell from './components/AppShell';
import { ClientLoginGate } from './shared/auth/ClientLoginGate';
import { useAuth } from './shared/auth/AuthContext';
import { trackAppOpen, trackConfigUsage, trackPageView } from './shared/analytics/analytics';
import type { SectionId } from './shared/types/navigation';

function isDeveloperSection(section: SectionId) {
  return section.startsWith('developer-');
}

function sectionRequiresPermission(section: SectionId, developerMode: boolean): string | null {
  const items = getAppMenuItems(developerMode);
  for (const it of items) {
    if (it.id === section && it.requiredPermission) return it.requiredPermission;
    if (it.children) {
      const child = it.children.find((ch) => ch.id === section);
      if (child) return child.requiredPermission || null;
    }
  }
  return null;
}

function firstPermittedSection(
  hasPermission: (key: string) => boolean,
  developerMode: boolean,
): SectionId {
  const items = getAppMenuItems(developerMode);
  for (const it of items) {
    if (it.children) {
      const child = it.children.find(
        (ch) => !ch.requiredPermission || hasPermission(ch.requiredPermission),
      );
      if (child) return child.id;
    } else if (!it.requiredPermission || hasPermission(it.requiredPermission)) {
      return it.id;
    }
  }
  return 'bid-generation';
}

function App() {
  const auth = useAuth();
  const [activeSection, setActiveSection] = useState<SectionId>('bid-generation');
  const [developerMode, setDeveloperMode] = useState(false);
  const leaveGuardRef = useRef<((nextSection?: string) => Promise<boolean>) | null>(null);

  useEffect(() => {
    trackAppOpen();

    void window.yibiao?.config.load()
      .then((config) => {
        setDeveloperMode(Boolean(config?.developer_mode));
        trackConfigUsage({}, config);
      })
      .catch((error) => console.warn('读取开发者模式失败', error));
  }, []);

  useEffect(() => {
    trackPageView(activeSection);
  }, [activeSection]);

  // 登录态就绪后，若当前/默认功能无权限，跳到第一个有权限的功能
  useEffect(() => {
    if (auth.loading || !auth.loggedIn) return;
    const req = sectionRequiresPermission(activeSection, developerMode);
    if (req && !auth.hasPermission(req)) {
      setActiveSection(firstPermittedSection(auth.hasPermission, developerMode));
    }
  }, [auth.loading, auth.loggedIn, auth.permissions, developerMode, activeSection]);

  useEffect(() => {
    if (!developerMode && isDeveloperSection(activeSection)) {
      setActiveSection('bid-generation');
    }
  }, [activeSection, developerMode]);

  const requestSectionChange = async (section: SectionId) => {
    if (section === activeSection) {
      return;
    }
    const req = sectionRequiresPermission(section, developerMode);
    if (req && !auth.hasPermission(req)) {
      return;
    }
    const allowed = await (leaveGuardRef.current?.(section) ?? Promise.resolve(true));
    if (allowed) {
      setActiveSection(section);
    }
  };

  if (auth.loading) {
    return (
      <div className="client-login-splash">
        <span>正在加载…</span>
      </div>
    );
  }

  if (!auth.loggedIn) {
    return <ClientLoginGate />;
  }

  return (
    <>
      <GpuHardwareAccelerationPrompt />
      <RequiredOnlineServicesPrompt />
      <UpdateNotifier />
      <LicenseStatusPrompt />
      <AppShell
        activeSection={activeSection}
        developerMode={developerMode}
        onSectionChange={(section) => { void requestSectionChange(section); }}
      >
        <AppRouter
          activeSection={activeSection}
          developerMode={developerMode}
          onDeveloperModeChange={setDeveloperMode}
          onSectionChange={(section) => { void requestSectionChange(section); }}
          registerLeaveGuard={(guard) => {
            leaveGuardRef.current = guard;
          }}
        />
      </AppShell>
    </>
  );
}

export default App;
