import type { ReactNode } from 'react';
import {
  AgentQuestionDialogProvider,
  AiHttpErrorDialogProvider,
  ConfirmDialogProvider,
  DocumentParseNoticeProvider,
  ToastProvider,
  DonationPromptProvider,
} from '../../shared/ui';
import { AuthProvider } from '../../shared/auth/AuthContext';
import { QaSessionProvider } from '../../features/knowledge-base/context/QaSessionProvider';

interface AppProvidersProps {
  children: ReactNode;
}

function AppProviders({ children }: AppProvidersProps) {
  return (
    <ToastProvider>
      <DonationPromptProvider>
        <AgentQuestionDialogProvider>
          <AiHttpErrorDialogProvider>
            <DocumentParseNoticeProvider>
              <ConfirmDialogProvider>
                <AuthProvider>
                  {/* 挂在顶层：问答的检索与生成不随问答页卸载而中断，
                      用户可以问完就切去生成标书，回来继续看结果 */}
                  <QaSessionProvider>{children}</QaSessionProvider>
                </AuthProvider>
              </ConfirmDialogProvider>
            </DocumentParseNoticeProvider>
          </AiHttpErrorDialogProvider>
        </AgentQuestionDialogProvider>
      </DonationPromptProvider>
    </ToastProvider>
  );
}

export default AppProviders;
