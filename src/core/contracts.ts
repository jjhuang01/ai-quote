export interface EchoBridgeMessage {
  id: string;
  source: 'extension' | 'webview' | 'bridge' | 'test';
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface EchoBridgeEvent<T = unknown> {
  type: string;
  timestamp: string;
  payload: T;
}

export interface EchoBridgeStatus {
  running: boolean;
  port: number;
  toolName: string;
  currentIde: string;
  messageCount: number;
  sseClientCount: number;
  autoConfiguredPaths: string[];
  lastConfiguredAt?: string;
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

// Webview state
export interface WebviewState {
  status: EchoBridgeStatus;
  history: HistoryItem[];
  queue: QueueItem[];
  accounts: AccountInfo[];
  feedback: FeedbackItem[];
  searchQuery: string;
  isWaiting: boolean;
  activeTab: 'status' | 'history' | 'queue' | 'feedback' | 'settings';
}
