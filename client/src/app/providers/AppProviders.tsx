import type { ReactNode } from 'react';
import { AiHttpErrorDialogProvider, DocumentParseNoticeProvider, ToastProvider } from '../../shared/ui';
import { AuthProvider } from '../../shared/auth/AuthContext';

interface AppProvidersProps {
  children: ReactNode;
}

function AppProviders({ children }: AppProvidersProps) {
  return (
    <ToastProvider>
      <AiHttpErrorDialogProvider>
        <DocumentParseNoticeProvider>
          <AuthProvider>{children}</AuthProvider>
        </DocumentParseNoticeProvider>
      </AiHttpErrorDialogProvider>
    </ToastProvider>
  );
}

export default AppProviders;
