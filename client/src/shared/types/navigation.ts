export type SectionId =
  | 'bid-generation'
  | 'technical-plan'
  | 'existing-plan-expansion'
  | 'feasibility-report'
  | 'business-bid'
  | 'knowledge-base'
  | 'document-knowledge-base'
  | 'image-knowledge-base'
  | 'kb-qa'
  | 'resources'
  | 'bid-check'
  | 'duplicate-check'
  | 'rejection-check'
  | 'ai-evaluation'
  | 'template-settings'
  | 'my-templates'
  | 'new-template'
  | 'export-format'
  | 'bid-opportunity'
  | 'developer-test'
  | 'developer-json-test'
  | 'developer-prompt-lab'
  | 'developer-parser-sandbox'
  | 'developer-export-preview'
  | 'developer-expansion-replace-test'
  | 'developer-agent-test'
  | 'settings'
  | 'account-list'
  | 'permission-list'
  | 'audit-log'
  | 'plugin-manager'
  | 'model-config';

export interface AppMenuNotice {
  message: string;
  actionLabel?: string;
  externalUrl?: string;
}

export interface AppSubMenuItem {
  id: SectionId;
  label: string;
  description: string;
  icon?: 'document' | 'expand' | 'briefcase' | 'compare' | 'shield' | 'code' | 'prompt' | 'file' | 'export' | 'tool' | 'chat';
  requiredPermission?: string;
  badge?: string;
  notice?: AppMenuNotice;
}

export interface AppMenuItem {
  id: SectionId;
  label: string;
  description: string;
  children?: AppSubMenuItem[];
  requiredPermission?: string;
  notice?: AppMenuNotice;
}
