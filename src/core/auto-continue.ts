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

const QUOTA_EXHAUSTED_SUMMARY_PATTERNS = [
  /quota.*(?:exhausted|exceeded)/i,
  /usage.*(?:exhausted|exceeded)/i,
  /(?:exhausted|exceeded).*quota/i,
  /(?:exhausted|exceeded).*usage/i,
  /配额.*(?:耗尽|用完|不足|超限)/i,
  /(?:耗尽|用完|不足|超限).*配额/i,
  /purchase extra usage/i,
  /rate limit/i,
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

  const isQuotaExhausted = QUOTA_EXHAUSTED_SUMMARY_PATTERNS.some((p) =>
    p.test(request.summary),
  );
  if (!isQuotaExhausted) {
    return { handled: false };
  }

  const currentQuota = await dependencies.refreshCurrentQuotaBeforeSwitch();
  if (!currentQuota.success) {
    return { handled: false };
  }

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
