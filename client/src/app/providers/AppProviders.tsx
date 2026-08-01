import type { ReactNode } from 'react';
import {
  AiHttpErrorDialogProvider,
  ConfirmDialogProvider,
  DocumentParseNoticeProvider,
  ToastProvider,
} from '../../shared/ui';
import { AuthProvider } from '../../shared/auth/AuthContext';

interface AppProvidersProps {
  children: ReactNode;
}

function AppProviders({ children }: AppProvidersProps) {
  return (
    <ToastProvider>
      <AiHttpErrorDialogProvider>
        <DocumentParseNoticeProvider>
          <ConfirmDialogProvider>
            <AuthProvider>{children}</AuthProvider>
          </ConfirmDialogProvider>
        </DocumentParseNoticeProvider>
      </AiHttpErrorDialogProvider>
    </ToastProvider>
  );
}

export default AppProviders;
