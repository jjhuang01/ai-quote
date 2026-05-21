import type { McpDialogRequest } from './contracts';

export interface AutoContinueDependencies {
  refreshCurrentQuotaBeforeSwitch: () => Promise<{ success: boolean; error?: string }>;
  autoSwitchIfNeeded: () => Promise<boolean>;
  getCurrentAccountId: () => Promise<string | undefined>;
  refreshQuotaAfterSwitch: (accountId: string, reason: string) => Promise<void>;
  resolveDialog: (sessionId: string, response: string) => void;
}

export interface AutoContinueResult {
  handled: boolean;
  reply?: string;
  switched?: boolean;
  accountId?: string;
}

const CONTINUE_OPTION_PATTERNS = [
  /^(?:continue|retry|resume)$/i,
  /\b(?:continue|retry|resume)\b/i,
  /继续|重试|续跑|恢复/i,
];

export function pickAutoContinueReply(request: McpDialogRequest): string | undefined {
  const option = request.options?.find((candidate) =>
    CONTINUE_OPTION_PATTERNS.some((pattern) => pattern.test(candidate)),
  );
  return option;
}

export async function handleAutoContinueDialog(
  request: McpDialogRequest,
  dependencies: AutoContinueDependencies,
): Promise<AutoContinueResult> {
  const reply = pickAutoContinueReply(request);
  if (!reply) {
    return { handled: false };
  }

  const currentQuota = await dependencies.refreshCurrentQuotaBeforeSwitch();
  if (!currentQuota.success) {
    return { handled: false };
  }

  // 对话框出现本身即证明当前账号已耗尽，无需依赖可能过期的本地计数器
  const switched = await dependencies.autoSwitchIfNeeded();
  if (!switched) {
    return { handled: false };
  }

  const accountId = await dependencies.getCurrentAccountId();
  if (accountId) {
    await dependencies.refreshQuotaAfterSwitch(accountId, 'auto-continue');
  }

  dependencies.resolveDialog(request.sessionId, reply);
  return {
    handled: true,
    reply,
    switched: true,
    accountId,
  };
}
