export interface QuoteMessage {
  id: string;
  source: 'extension' | 'webview' | 'bridge' | 'test';
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface QuoteEvent<T = unknown> {
  type: string;
  timestamp: string;
  payload: T;
}

export interface QuoteStatus {
  running: boolean;
  port: number;
  toolName: string;
  currentIde: string;
  messageCount: number;
  sseClientCount: number;
  autoConfiguredPaths: string[];
  lastConfiguredAt?: string;
  pendingDialog?: McpDialogRequest;
}

export interface McpDialogRequest {
  id: number | string;
  sessionId: string;
  summary: string;
  options?: string[];
  isMarkdown?: boolean;
  receivedAt: string;
}

export interface ImageAttachment {
  data: string;        // base64 encoded (without data URI prefix)
  media_type: string;  // e.g. 'image/png', 'image/jpeg'
  filename?: string;
}

export interface DialogResponse {
  text: string;
  images: ImageAttachment[];
}

export interface RemoteApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
}

export interface VersionInfo {
  name: string;
  version: string;
  mode: 'local-rebuild' | 'remote-proxy';
}

export interface VerifyRequest {
  code?: string;
  serverUrl?: string;
}

export interface FirebaseLoginRequest {
  email: string;
  password: string;
  apiKey?: string;
}

export interface McpServerConfig {
  url: string;
  timeout?: number;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export interface IdeTarget {
  id: 'windsurf' | 'cursor' | 'kiro' | 'trae' | 'vscode';
  name: string;
  appNames: string[];
  configPath: string;
  confidence: 'proven' | 'inferred';
}

export interface RuleWriteResult {
  path: string;
  written: boolean;
  reason?: string;
}

// History types
export interface HistoryItem {
  id: string;
  type: 'conversation' | 'feedback' | 'event';
  title: string;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

// Queue types
export interface QueueItem {
  id: string;
  type: 'message' | 'feedback' | 'event' | 'command';
  payload: unknown;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: string;
  processedAt?: string;
  error?: string;
  retries: number;
}

// Account types
export interface AccountInfo {
  id: string;
  email?: string;
  displayName?: string;
  provider: 'windsurf' | 'firebase' | 'local';
  createdAt: string;
  lastLoginAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AccountStats {
  totalConversations: number;
  totalMessages: number;
  totalFeedback: number;
  lastActiveAt?: string;
}

// Feedback types
export interface FeedbackItem {
  id: string;
  conversationId?: string;
  rating: 'positive' | 'negative' | 'neutral';
  comment?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

// Windsurf Account (支持 2026.3 日/周配额模型)
export interface WindsurfAccount {
  id: string;
  email: string;
  password: string;
  // Codeium API Key（通过 RegisterUser RPC 获取，用于无感切号注入）
  apiKey?: string;
  // Codeium API Server URL（默认 https://server.codeium.com）
  apiServerUrl?: string;
  plan: 'Trial' | 'Pro' | 'Enterprise' | 'Free' | 'Max' | 'Teams';
  // 旧字段 (向后兼容)
  creditsUsed: number;
  creditsTotal: number;
  // 新配额字段 (2026.3+)
  quota: AccountQuota;
  expiresAt: string;
  isActive: boolean;
  lastCheckedAt?: string;
  addedAt: string;
  realQuota?: RealQuotaInfo;
}

export interface AccountQuota {
  dailyUsed: number;
  dailyLimit: number;
  dailyResetAt: string;   // ISO 时间
  weeklyUsed: number;
  weeklyLimit: number;
  weeklyResetAt: string;  // ISO 时间
}

export const DEFAULT_QUOTA: AccountQuota = {
  dailyUsed: 0,
  dailyLimit: 0,
  dailyResetAt: '',
  weeklyUsed: 0,
  weeklyLimit: 0,
  weeklyResetAt: ''
};

// Settings (对齐原始插件设置Tab)
export interface PluginSettings {
  // 外观设置
  theme: 'dark' | 'light' | 'auto';
  panelPosition: 'right' | 'left' | 'bottom';
  // 弹窗尺寸
  feedbackHeight: number;
  inputHeight: number;
  fontSize: number;
  cardOpacity: number;
  breathingLightColor: string;
  // 快捷键设置
  enterToSend: boolean;
  showUserPrompt: boolean;
  // 历史记录设置
  historyLimit: number;
  // 提示音设置
  soundAlert: 'none' | 'tada' | 'ding' | 'pop' | 'chime';
  // 配额获取
  firebaseApiKey: string;          // Codeium Firebase Web API Key (用于通道B)
  // MCP 清理白名单：这些名称的 MCP 服务不会被清理工具移除
  mcpWhitelist: string[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  theme: 'dark',
  panelPosition: 'right',
  feedbackHeight: 400,
  inputHeight: 100,
  fontSize: 14,
  cardOpacity: 80,
  breathingLightColor: '#00ff88',
  enterToSend: false,
  showUserPrompt: false,
  historyLimit: 30,
  soundAlert: 'tada',
  firebaseApiKey: '',
  mcpWhitelist: ['qdrant', 'pencil', 'fetch', 'context7', 'playwright', 'repomix', 'toon']
};

// Shortcut (快捷短语)
export interface ShortcutItem {
  id: string;
  content: string;
  createdAt: string;
}

// Template (系统提示词模板)
export interface TemplateItem {
  id: string;
  name: string;
  content: string;
  createdAt: string;
}

// Usage Stats (使用统计)
export interface UsageStats {
  totalConversations: number;
  continueCount: number;
  pauseCount: number;
  endCount: number;
  dailyAverage: number;
  continueRate: number;
  lastResetAt: string;
}

// Auto-switch settings (自动切换设置 - 日/周配额感知)
export interface AutoSwitchConfig {
  enabled: boolean;
  threshold: number;           // 剩余配额低于此值时触发切换
  checkInterval: number;       // 检查间隔(秒)
  creditWarning: number;       // 配额预警值
  switchOnDaily: boolean;      // 日配额触顶时切换
  switchOnWeekly: boolean;     // 周配额触顶时切换
}

export const DEFAULT_AUTO_SWITCH: AutoSwitchConfig = {
  enabled: false,
  threshold: 5,
  checkInterval: 60,
  creditWarning: 3,
  switchOnDaily: true,
  switchOnWeekly: true
};

// 配额快照 (传给 Webview 显示)
export interface QuotaSnapshot {
  accountId: string;
  email: string;
  plan: string;
  dailyUsed: number;
  dailyLimit: number;
  dailyRemaining: number;
  dailyResetIn: string;    // 人类可读倒计时
  weeklyUsed: number;
  weeklyLimit: number;
  weeklyRemaining: number;
  weeklyResetIn: string;
  warningLevel: 'ok' | 'warn' | 'critical';
  // 真实配额 (来自 API/本地读取)
  real?: RealQuotaInfo;
}

// Webview bootstrap data
export interface WebviewBootstrap {
  status: QuoteStatus;
  history: HistoryItem[];
  accounts: WindsurfAccount[];
  shortcuts: ShortcutItem[];
  templates: TemplateItem[];
  settings: PluginSettings;
  usageStats: UsageStats;
  autoSwitch: AutoSwitchConfig;
  currentAccountId?: string;
  licenseInfo?: LicenseInfo;
  quotaSnapshots: QuotaSnapshot[];
  quotaFetching?: boolean;
  responseQueue?: string[];
}

export interface LicenseInfo {
  key: string;
  type: 'permanent' | 'trial' | 'subscription';
  expiresAt: string;
  isActive: boolean;
}

// 真实 Windsurf Plan 配额 (从 cachedPlanInfo 逆向)
export interface RealQuotaInfo {
  planName: string;
  billingStrategy: string;         // 'quota' | 'credits'
  dailyRemainingPercent: number;   // 0-100
  weeklyRemainingPercent: number;  // 0-100
  dailyResetAtUnix: number;        // unix seconds
  weeklyResetAtUnix: number;       // unix seconds
  messages: number;
  usedMessages: number;
  remainingMessages: number;
  flowActions: number;
  usedFlowActions: number;
  remainingFlowActions: number;
  overageBalanceMicros: number;
  planEndTimestamp?: number;       // unix ms (from planEnd ISO), 0 = unknown
  fetchedAt: string;               // ISO
  source: 'local' | 'api' | 'apikey' | 'cache' | 'proto';
}

// Webview state (前端状态)
export interface WebviewState {
  activeTab: 'status' | 'account' | 'history' | 'shortcut' | 'template' | 'settings' | 'update';
  searchQuery: string;
  isWaiting: boolean;
}

// Backward-compat aliases
export type EchoBridgeMessage = QuoteMessage;
export type EchoBridgeEvent<T = unknown> = QuoteEvent<T>;
export type EchoBridgeStatus = QuoteStatus;
