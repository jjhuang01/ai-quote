import "./main.css";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

// ---- Types ----

interface BridgeStatus {
  running: boolean;
  port: number;
  toolName: string;
  currentIde: string;
  messageCount: number;
  sseClientCount: number;
  autoConfiguredPaths: string[];
  lastConfiguredAt?: string;
}

interface HistoryItem {
  id: string;
  type: "conversation" | "feedback" | "event";
  title: string;
  content: string;
  createdAt: string;
}

interface WindsurfAccount {
  id: string;
  email: string;
  plan: "Trial" | "Pro" | "Enterprise" | "Free" | "Max" | "Teams";
  creditsUsed: number;
  creditsTotal: number;
  quota: {
    dailyUsed: number;
    dailyLimit: number;
    dailyResetAt: string;
    weeklyUsed: number;
    weeklyLimit: number;
    weeklyResetAt: string;
  };
  expiresAt: string;
  isActive: boolean;
  addedAt: string;
}

interface RealQuotaInfo {
  planName: string;
  billingStrategy: string;
  dailyRemainingPercent: number;
  weeklyRemainingPercent: number;
  dailyResetAtUnix: number;
  weeklyResetAtUnix: number;
  messages: number;
  usedMessages: number;
  remainingMessages: number;
  flowActions: number;
  usedFlowActions: number;
  remainingFlowActions: number;
  overageBalanceMicros: number;
  planEndTimestamp?: number;
  fetchedAt: string;
  source: "local" | "api" | "apikey" | "cache" | "proto";
}

interface QuotaSnapshot {
  accountId: string;
  email: string;
  plan: string;
  dailyUsed: number;
  dailyLimit: number;
  dailyRemaining: number;
  dailyResetIn: string;
  weeklyUsed: number;
  weeklyLimit: number;
  weeklyRemaining: number;
  weeklyResetIn: string;
  warningLevel: "ok" | "warn" | "critical";
  real?: RealQuotaInfo;
}

interface ShortcutItem {
  id: string;
  content: string;
  createdAt: string;
}

interface TemplateItem {
  id: string;
  name: string;
  content: string;
  createdAt: string;
}

interface PluginSettings {
  theme: "dark" | "light" | "auto";
  panelPosition: "right" | "left" | "bottom";
  feedbackHeight: number;
  inputHeight: number;
  fontSize: number;
  cardOpacity: number;
  breathingLightColor: string;
  enterToSend: boolean;
  showUserPrompt: boolean;
  historyLimit: number;
  soundAlert: "none" | "tada" | "ding" | "pop" | "chime";
  firebaseApiKey: string;
  mcpWhitelist: string[];
}

interface UsageStats {
  totalConversations: number;
  continueCount: number;
  pauseCount: number;
  endCount: number;
  dailyAverage: number;
  continueRate: number;
  lastResetAt: string;
}

interface AutoSwitchConfig {
  enabled: boolean;
  threshold: number;
  checkInterval: number;
  creditWarning: number;
  switchOnDaily: boolean;
  switchOnWeekly: boolean;
}

interface McpDialogRequest {
  id: number | string;
  sessionId: string;
  summary: string;
  options?: string[];
  isMarkdown?: boolean;
  receivedAt: string;
}

interface Bootstrap {
  status: BridgeStatus & { pendingDialog?: McpDialogRequest };
  logPath: string;
  history: HistoryItem[];
  accounts: WindsurfAccount[];
  shortcuts: ShortcutItem[];
  templates: TemplateItem[];
  settings: PluginSettings;
  usageStats: UsageStats;
  autoSwitch: AutoSwitchConfig;
  currentAccountId?: string;
  quotaSnapshots: QuotaSnapshot[];
  quotaFetching?: boolean;
  responseQueue?: string[];
}

declare global {
  interface Window {
    __QUOTE_BOOTSTRAP__: Bootstrap;
  }
}

// ---- Inline SVG Icons (零依赖方案) ----

const SVG_ICONS: Record<string, string> = {
  // Tab 导航
  status:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  account:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  history:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  tools:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>',
  settings:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 010 4h-.09c-.658.003-1.25.396-1.51 1z"/></svg>',
  // 操作图标
  refresh:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>',
  trash:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>',
  plus: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  upload:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  switchIcon:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>',
  edit: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  // 维护区图标
  broom:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h4l10-10-4-4L3 17v4z"/><path d="M14.5 5.5l4 4"/></svg>',
  reset:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2v6h6"/><path d="M2.5 8A10 10 0 0112 2a10 10 0 110 20 10 10 0 01-7.35-3.22"/></svg>',
  fileText:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  database:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  wrench:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>',
  // Toast / 状态图标
  check:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  alertCircle:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  search:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  inbox:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>',
  // Plan 图标
  crown:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M2 20h20l-2-12-5 5-3-7-3 7-5-5-2 12z"/></svg>',
  star: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
  zap: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  // History type 图标
  message:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
  starOutline:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  radio:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/></svg>',
  // Diagnose 状态图标
  checkCircle:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  xCircle:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  copy: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
};

function icon(name: string, cls = ""): string {
  const svg = SVG_ICONS[name] ?? "";
  return cls
    ? `<span class="svg-icon ${cls}">${svg}</span>`
    : `<span class="svg-icon">${svg}</span>`;
}

// ---- State ----

type TabId = "status" | "account" | "history" | "tools" | "settings" | "debug";

const vscode = acquireVsCodeApi();

let state = {
  activeTab: "status" as TabId,
  historySearch: "",
  isWaiting: false,
  expandedHistoryId: undefined as string | undefined,
  historyMenuId: undefined as string | undefined,
  // Account
  showAddAccount: false,
  showImportAccount: false,
  importText: "",
  addEmail: "",
  addPassword: "",
  // Shortcut
  editingShortcutId: undefined as string | undefined,
  editingShortcutText: "",
  newShortcutText: "",
  // Template
  editingTemplateId: undefined as string | undefined,
  editingTemplateName: "",
  editingTemplateContent: "",
  newTemplateName: "",
  newTemplateContent: "",
  // Quota editor
  editingQuotaAccountId: undefined as string | undefined,
  quotaDailyLimit: 0,
  quotaWeeklyLimit: 0,
  // Notification
  notification: undefined as string | undefined,
  notificationType: "info" as "info" | "success" | "error",
  // Quota fetching
  quotaFetching: false,
  // Per-account quota fetching id (single-account refresh)
  quotaFetchingId: undefined as string | undefined,
  // Maintenance loading
  maintenanceLoadingAction: undefined as string | undefined,
  // Switch loading
  switchLoadingId: undefined as string | undefined,
  // MCP pending dialog
  pendingDialog: undefined as McpDialogRequest | undefined,
  dialogInput: "",
  dialogCallCount: 0,
  // Pre-response queue: auto-send in order when LLM calls tools/call
  responseQueue: [] as string[],
  queueInput: "",
  queueCollapsed: false,
  editingQueueIdx: undefined as number | undefined,
  editingQueueText: "",
  // Sent history: last N items sent (manual + auto-queue)
  sentHistory: [] as Array<{ text: string; sentAt: string; mode: 'manual' | 'queue' }>,
  // Diagnose result
  diagnoseResult: undefined as
    | {
        checks: Array<{ name: string; ok: boolean; detail: string }>;
        repaired?: number;
      }
    | undefined,
  // Debug panel
  debugInfo: undefined as
    | {
        logPath: string;
        logContent: string;
        patchApplied: boolean;
        patchExtensionPath: string | null;
        patchError: string | null;
      }
    | undefined,
  debugLoading: false,
};

// ---- Render Root ----

function render(): void {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) return;
  const bs = window.__QUOTE_BOOTSTRAP__;
  root.innerHTML = `
    <main class="infinite-shell">
      ${renderHeader(bs)}
      ${state.pendingDialog ? '<div class="dialog-redirect-hint"><span>⏸</span> 对话已在编辑器标签页中打开，请在编辑器中回复</div>' : ''}
      ${renderTabNav()}
      ${renderActiveTab(bs)}
      ${state.notification ? `<div class="toast toast-${state.notificationType}">${state.notificationType === "success" ? icon("check") : state.notificationType === "error" ? icon("alertCircle") : icon("info")} ${escapeHtml(state.notification)}</div>` : ""}
    </main>`;
  bindEvents();
  // JS 程序化设置进度条宽度（绕过 CSP 对 inline style 的限制）
  root
    .querySelectorAll<HTMLElement>(".quota-bar-fill[data-pct]")
    .forEach((el) => {
      el.style.width = `${el.dataset.pct}%`;
    });
}

// ---- Header ----

function renderHeader(bs: Bootstrap): string {
  return `
    <header class="infinite-header">
      <div class="header-brand">
        <span class="header-title">Quote${state.pendingDialog ? ' ⏸' : ''}</span>
        <span class="header-sub">:${bs.status.port} · ${escapeHtml(bs.status.currentIde)}</span>
      </div>
      <span class="status-pill ${bs.status.running ? "online" : "offline"}">
        <span class="pill-dot"></span>
        ${bs.status.running ? "在线" : "离线"}
      </span>
    </header>`;
}

// ---- Tab Nav ----

function renderTabNav(): string {
  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "status", label: "状态", icon: "status" },
    { id: "account", label: "账号", icon: "account" },
    { id: "history", label: "历史", icon: "history" },
    { id: "tools", label: "工具", icon: "tools" },
    { id: "settings", label: "设置", icon: "settings" },
    { id: "debug", label: "调试", icon: "wrench" },
  ];
  return `
    <nav class="tab-nav">
      ${tabs
        .map(
          (t) => `
        <button class="tab-btn ${state.activeTab === t.id ? "active" : ""}" data-tab="${t.id}" title="${t.label}">
          ${t.label}
        </button>`,
        )
        .join("")}
    </nav>`;
}

function renderActiveTab(bs: Bootstrap): string {
  switch (state.activeTab) {
    case "status":
      return renderStatusTab(bs);
    case "account":
      return renderAccountTab(bs);
    case "history":
      return renderHistoryTab(bs);
    case "tools":
      return renderToolsTab(bs);
    case "settings":
      return renderSettingsTab(bs);
    case "debug":
      return renderDebugTab(bs);
  }
}

// ---- Status Tab ----

function renderStatusTab(bs: Bootstrap): string {
  const { status, usageStats } = bs;
  const continueRate = usageStats.continueRate;
  const circumference = 2 * Math.PI * 28;
  const dashoffset = circumference - (continueRate / 100) * circumference;

  return `
    <div class="tab-content">
      ${
        state.isWaiting
          ? `
        <div class="waiting-card">
          <div class="waiting-gl"><div class="waiting-spinner"></div></div>
          <span class="waiting-text">等待 AI 响应...</span>
        </div>`
          : ""
      }

      <section class="card">
        <div class="section-header"><h2>桥接服务</h2></div>
        <div class="service-status-row">
          <div class="service-indicator ${status.running ? "running" : "stopped"}">
            <span class="indicator-dot"></span>
            <span>${status.running ? "运行中" : "已停止"}</span>
          </div>
          <div class="service-meta">
            <span>SSE <b>${status.sseClientCount}</b></span>
            <span>消息 <b>${status.messageCount}</b></span>
            <span>配置 <b>${status.autoConfiguredPaths.length}</b></span>
          </div>
        </div>
        <div class="actions" style="margin-top:8px">
          <button class="btn-grad" data-action="refresh">刷新</button>
          <button class="btn-secondary" data-action="testFeedback">测试反馈</button>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>使用统计</h2></div>
        <div class="stats-row">
          <div class="donut-wrap">
            <svg class="donut" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="28" fill="none" stroke="var(--border)" stroke-width="6"/>
              <circle cx="32" cy="32" r="28" fill="none" stroke="var(--accent)" stroke-width="6"
                stroke-dasharray="${circumference.toFixed(1)}"
                stroke-dashoffset="${dashoffset.toFixed(1)}"
                stroke-linecap="round"
                transform="rotate(-90 32 32)"/>
            </svg>
            <div class="donut-label">
              <span class="donut-value">${continueRate}%</span>
              <span class="donut-sub">继续率</span>
            </div>
          </div>
          <div class="stats-grid-2">
            <div class="stat-cell">
              <div class="stat-num">${usageStats.totalConversations}</div>
              <div class="stat-lbl">总对话</div>
            </div>
            <div class="stat-cell">
              <div class="stat-num">${usageStats.continueCount}</div>
              <div class="stat-lbl">继续</div>
            </div>
            <div class="stat-cell">
              <div class="stat-num">${usageStats.endCount}</div>
              <div class="stat-lbl">结束</div>
            </div>
            <div class="stat-cell">
              <div class="stat-num">${usageStats.dailyAverage}</div>
              <div class="stat-lbl">日均</div>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>会话控制</h2></div>
        <div class="actions">
          <button class="btn-grad" data-action="sessionContinue">继续</button>
          <button class="btn-danger" data-action="sessionEnd">结束</button>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>已配置路径</h2></div>
        <ul class="paths">
          ${
            status.autoConfiguredPaths.length > 0
              ? status.autoConfiguredPaths
                  .map((p) => `<li class="config-item">${escapeHtml(p)}</li>`)
                  .join("")
              : `<li class="empty-state">${icon("inbox", "empty-icon")} 暂无自动配置路径</li>`
          }
        </ul>
      </section>

      <section class="card">
        <div class="section-header">
          <h2>发送队列</h2>
          <div class="btn-group">
            <span class="badge ${state.responseQueue.length > 0 ? 'badge-ok' : 'badge-neutral'}">${state.responseQueue.length} 条</span>
            <button class="btn-xs" data-action="queueToggle" title="${state.queueCollapsed ? '展开' : '折叠'}">${state.queueCollapsed ? '▶' : '▼'}</button>
            ${state.responseQueue.length > 0 ? `<button class="btn-xs btn-danger-xs" data-action="queueClear" title="清空队列">🗑</button>` : ''}
          </div>
        </div>

        ${state.sentHistory.length > 0 ? `
        <div class="sent-history">
          <div class="sent-history-label">📤 已发送内容 <span class="sent-count">(共 ${state.sentHistory.length} 条)</span></div>
          <ul class="sent-list">
            ${state.sentHistory.slice(0, 3).map(item => `
            <li class="sent-item ${item.mode === 'queue' ? 'sent-queue' : 'sent-manual'}">
              <span class="sent-badge">${item.mode === 'queue' ? '队列' : '手动'}</span>
              <span class="sent-text">${escapeHtml(item.text.slice(0, 60))}${item.text.length > 60 ? '…' : ''}</span>
              <span class="sent-ts">${item.sentAt}</span>
            </li>`).join('')}
          </ul>
        </div>` : ''}

        ${!state.queueCollapsed ? `
        <p class="hint">LLM 每次调用工具时，自动从队列头部取一条回复。用 <code>---</code> 分隔可批量添加。</p>
        <div class="queue-input-row">
          <textarea class="text-area queue-input" id="queue-add-input" rows="2" placeholder="输入预设回复… (Ctrl+Enter 加入，用 --- 分隔可批量添加)">${escapeHtml(state.queueInput)}</textarea>
          <button class="btn-grad btn-sm" data-action="queueAdd">+加入</button>
        </div>
        ${state.responseQueue.length > 0 ? `
        <ol class="queue-list">
          ${state.responseQueue.map((item, i) => {
            const isEditing = state.editingQueueIdx === i;
            const total = state.responseQueue.length;
            if (isEditing) {
              return `
              <li class="queue-item queue-item-editing">
                <span class="queue-idx">#${i + 1}</span>
                <textarea class="queue-edit-input" id="queue-edit-${i}" rows="2">${escapeHtml(state.editingQueueText)}</textarea>
                <div class="queue-edit-btns">
                  <button class="btn-xs" data-action="queueEditSave" data-idx="${i}">✓</button>
                  <button class="btn-xs btn-danger-xs" data-action="queueEditCancel">✕</button>
                </div>
              </li>`;
            }
            return `
            <li class="queue-item">
              <span class="queue-idx">#${i + 1}</span>
              <span class="queue-text">${escapeHtml(item.slice(0, 80))}${item.length > 80 ? '…' : ''}</span>
              <div class="queue-item-btns">
                ${i > 0 ? `<button class="btn-xs" data-action="queueMoveUp" data-idx="${i}" title="上移">↑</button>` : ''}
                ${i < total - 1 ? `<button class="btn-xs" data-action="queueMoveDown" data-idx="${i}" title="下移">↓</button>` : ''}
                <button class="btn-xs" data-action="queueEdit" data-idx="${i}" title="编辑">✎</button>
                <button class="btn-xs btn-danger-xs" data-action="queueRemove" data-idx="${i}" title="删除">×</button>
              </div>
            </li>`;
          }).join('')}
        </ol>` : '<p class="hint empty-queue-hint">队列为空，添加后 LLM 将自动回复。</p>'}
        ${state.dialogCallCount > 0 ? `<p class="hint" style="margin-top:8px">已处理 ${state.dialogCallCount} 次调用（含队列自动回复）</p>` : ''}
        ` : ''}
      </section>
    </div>`;
}

// ---- Account Tab ----

function renderAccountTab(bs: Bootstrap): string {
  const { accounts, autoSwitch, quotaSnapshots } = bs;
  const snapshotMap = new Map(quotaSnapshots.map((s) => [s.accountId, s]));
  const isFetching = bs.quotaFetching || state.quotaFetching;

  return `
    <div class="tab-content">
      <section class="card">
        <div class="section-header">
          <h2>账号 (${accounts.length})</h2>
          <div class="btn-group">
            <button class="btn-xs btn-icon ${isFetching ? "disabled" : ""}" data-action="fetchAllQuotas" ${isFetching ? "disabled" : ""} title="刷新全部配额">${isFetching ? `${icon("refresh")} …` : `${icon("refresh")} 配额`}</button>
            <button class="btn-xs btn-icon" data-action="toggleAddAccount">${icon("plus")} 添加</button>
            <button class="btn-xs btn-icon" data-action="toggleImportAccount">${icon("upload")} 批量</button>
            ${accounts.length > 0 ? `<button class="btn-xs btn-danger-xs" data-action="accountClear">清空</button>` : ""}
          </div>
        </div>

        ${
          state.showAddAccount
            ? `
          <div class="inline-form">
            <p class="hint">格式: 邮箱 密码（空格分隔）</p>
            <input class="text-input" id="addAccountLine" type="text" placeholder="user@mail.com password123" value="${escapeHtml(state.addEmail)}">
            <div class="btn-group">
              <button class="btn-grad btn-sm" data-action="accountAdd">确认添加</button>
              <button class="btn-secondary btn-sm" data-action="toggleAddAccount">取消</button>
            </div>
          </div>`
            : ""
        }

        ${
          state.showImportAccount
            ? `
          <div class="inline-form">
            <p class="hint">${icon("upload")} 批量导入 (每行: 邮箱 密码)</p>
            <textarea class="text-area" id="importText" rows="5" placeholder="user1@mail.com pass123\nuser2@mail.com pass456">${escapeHtml(state.importText)}</textarea>
            <div class="btn-group">
              <button class="btn-grad btn-sm" data-action="accountImport">导入</button>
              <button class="btn-secondary btn-sm" data-action="toggleImportAccount">取消</button>
            </div>
          </div>`
            : ""
        }

        <div class="account-list">
          ${
            accounts.length > 0
              ? accounts
                  .map((a) =>
                    renderAccountItem(
                      a,
                      bs.currentAccountId,
                      snapshotMap.get(a.id),
                    ),
                  )
                  .join("")
              : `<div class="empty-state">${icon("inbox", "empty-icon")} <p>暂无账号，点击“添加”或“批量导入”</p></div>`
          }
        </div>
      </section>

      ${state.editingQuotaAccountId ? renderQuotaEditor(bs) : ""}

      <section class="card">
        <div class="section-header"><h2>自动切换</h2></div>
        <div class="settings-section">
          <div class="setting-row">
            <span class="setting-label">启用自动切换</span>
            <label class="toggle">
              <input type="checkbox" id="autoSwitchEnabled" ${autoSwitch.enabled ? "checked" : ""}>
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">日配额触顶时切换</span>
            <label class="toggle">
              <input type="checkbox" id="autoSwitchOnDaily" ${autoSwitch.switchOnDaily ? "checked" : ""}>
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">周配额触顶时切换</span>
            <label class="toggle">
              <input type="checkbox" id="autoSwitchOnWeekly" ${autoSwitch.switchOnWeekly ? "checked" : ""}>
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">剩余配额阈值</span>
            <input class="num-input" id="autoSwitchThreshold" type="number" value="${autoSwitch.threshold}" min="0" max="999">
          </div>
          <div class="setting-row">
            <span class="setting-label">配额预警值</span>
            <input class="num-input" id="autoSwitchCreditWarning" type="number" value="${autoSwitch.creditWarning}" min="0" max="999">
          </div>
        </div>
        <div class="actions">
          <button class="btn-grad btn-sm" data-action="autoSwitchSave">保存设置</button>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>高级操作</h2></div>
        <div class="actions">
          <button class="btn-secondary" data-action="resetMachineId">重置机器 ID</button>
        </div>
        <p class="hint">重置 Windsurf 机器标识，用于解除设备绑定限制</p>
      </section>
    </div>`;
}

function renderAccountItem(
  a: WindsurfAccount,
  currentId?: string,
  snapshot?: QuotaSnapshot,
): string {
  const isCurrent = a.id === currentId || a.isActive;
  const planColors: Record<string, string> = {
    Pro: "var(--accent)",
    Max: "#8b5cf6",
    Enterprise: "#a855f7",
    Teams: "#06b6d4",
  };
  const planColor = planColors[a.plan] ?? "var(--muted)";
  const q = snapshot;
  const rq = q?.real;

  let dailyFillPct: number | null = null; // 已用% (0=未用, 100=耗尽), null = 无数据
  let weeklyFillPct: number | null = null;
  let dailyText = "";
  let weeklyText = "";
  let dailyResetText = "";
  let weeklyResetText = "";
  let planEndText = "";

  if (rq) {
    // -1 = API 未返回此字段（无数据），显示 "—"；否则 bar fill = 已用% (与 Windsurf 一致)
    dailyFillPct =
      rq.dailyRemainingPercent >= 0
        ? Math.max(0, Math.min(100, 100 - rq.dailyRemainingPercent))
        : null;
    weeklyFillPct =
      rq.weeklyRemainingPercent >= 0
        ? Math.max(0, Math.min(100, 100 - rq.weeklyRemainingPercent))
        : null;
    dailyText = dailyFillPct !== null ? `${Math.floor(dailyFillPct)}%` : "";
    weeklyText = weeklyFillPct !== null ? `${Math.floor(weeklyFillPct)}%` : "";
    if (rq.dailyResetAtUnix)
      dailyResetText = formatResetDateTime(rq.dailyResetAtUnix * 1000);
    if (rq.weeklyResetAtUnix)
      weeklyResetText = formatResetDateTime(rq.weeklyResetAtUnix * 1000);
    if (rq.planEndTimestamp && rq.planEndTimestamp > 0) {
      const endDate = new Date(rq.planEndTimestamp);
      planEndText = endDate.toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      });
    }
  } else if (q && q.dailyLimit > 0) {
    // 旧配额字段: 计算剩余%
    dailyFillPct = pct(q.dailyUsed, q.dailyLimit);
    weeklyFillPct = q.weeklyLimit > 0 ? pct(q.weeklyUsed, q.weeklyLimit) : null;
    dailyText = `${Math.round(dailyFillPct)}%`;
    weeklyText = weeklyFillPct !== null ? `${Math.round(weeklyFillPct)}%` : "";
    dailyResetText = q.dailyResetIn;
    weeklyResetText = q.weeklyResetIn;
  } else if (a.creditsTotal > 0) {
    dailyFillPct = pct(a.creditsUsed, a.creditsTotal);
    dailyText = `${Math.round(dailyFillPct)}%`;
  }

  // fillClass based on usage% (low usage = ok, high usage = danger)
  const fillClass = (usedPct: number | null): string => {
    if (usedPct === null) return "";
    if (usedPct < 50) return "quota-fill-ok";
    if (usedPct < 80) return "quota-fill-warn";
    return "quota-fill-danger";
  };

  const refreshing = state.quotaFetching || state.quotaFetchingId === a.id;
  return `
    <div class="ac-card ${isCurrent ? "ac-active" : ""} ${q?.warningLevel === "critical" ? "ac-crit" : q?.warningLevel === "warn" ? "ac-warn" : ""}">
      <div class="ac-head">
        <span class="ac-email" title="${escapeHtml(a.email)}">${escapeHtml(a.email)}</span>
        <div class="ac-tags">
          <span class="plan-badge plan-${a.plan.toLowerCase()}">${planIcon(a.plan)} ${a.plan}</span>
          ${isCurrent ? '<span class="badge-active">当前</span>' : ""}
          ${planEndText ? `<span class="ac-end">${planEndText}</span>` : ""}
        </div>
      </div>
      <div class="ac-foot">
        <div class="ac-bars">
          <div class="ac-bar-row">
            <span class="ac-lbl">周</span>
            <div class="ac-track"><div class="ac-fill ${fillClass(weeklyFillPct)}" style="width:${weeklyFillPct ?? 0}%"></div></div>
            <span class="ac-pct${weeklyFillPct === null ? " ac-nodata" : ""}">${weeklyText || "—"}</span>
            ${weeklyResetText ? `<span class="ac-rt">${weeklyResetText}</span>` : '<span class="ac-rt"></span>'}
          </div>
          <div class="ac-bar-row">
            <span class="ac-lbl">日</span>
            <div class="ac-track"><div class="ac-fill ${fillClass(dailyFillPct)}" style="width:${dailyFillPct ?? 0}%"></div></div>
            <span class="ac-pct${dailyFillPct === null ? " ac-nodata" : ""}">${dailyText || "—"}</span>
            ${dailyResetText ? `<span class="ac-rt">${dailyResetText}</span>` : '<span class="ac-rt"></span>'}
          </div>
        </div>
        <div class="ac-acts">
          <button class="ac-btn ac-btn-refresh ${refreshing ? "ac-loading" : ""}" data-action="fetchQuota" data-id="${a.id}" title="刷新配额" ${refreshing ? "disabled" : ""}><span class="ac-refresh-ico">${SVG_ICONS["refresh"]}</span></button>
          ${!isCurrent ? `<button class="ac-btn ${state.switchLoadingId === a.id ? "ac-btn-loading" : ""}" data-action="accountSwitch" data-id="${a.id}" ${state.switchLoadingId === a.id ? "disabled" : ""}>${state.switchLoadingId === a.id ? "…" : "切换"}</button>` : ""}
          <button class="ac-btn ac-btn-del" data-action="accountDelete" data-id="${a.id}">删除</button>
        </div>
      </div>
    </div>`;
}

function renderQuotaEditor(bs: Bootstrap): string {
  const account = bs.accounts.find((a) => a.id === state.editingQuotaAccountId);
  if (!account) return "";
  return `
    <section class="card">
      <div class="section-header"><h2>配额限额 · ${escapeHtml(account.email)}</h2></div>
      <div class="settings-section">
        <div class="setting-row">
          <span class="setting-label">日配额上限</span>
          <input class="num-input" id="quotaDailyLimit" type="number" value="${state.quotaDailyLimit}" min="0" max="9999">
        </div>
        <div class="setting-row">
          <span class="setting-label">周配额上限</span>
          <input class="num-input" id="quotaWeeklyLimit" type="number" value="${state.quotaWeeklyLimit}" min="0" max="9999">
        </div>
      </div>
      <div class="btn-group">
        <button class="btn-grad btn-sm" data-action="quotaSaveLimits" data-id="${account.id}">保存</button>
        <button class="btn-secondary btn-sm" data-action="quotaCancelEdit">取消</button>
      </div>
    </section>`;
}

function planIcon(plan: string): string {
  switch (plan) {
    case "Pro":
      return icon("crown", "plan-icon-pro");
    case "Max":
      return icon("zap", "plan-icon-max");
    case "Enterprise":
    case "Teams":
      return icon("star", "plan-icon-teams");
    case "Trial":
      return icon("zap", "plan-icon-trial");
    default:
      return "";
  }
}

function pct(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
}

function formatResetDateTime(ms: number): string {
  const d = new Date(ms);
  const M = d.getMonth() + 1;
  const D = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${M}/${D} ${hh}:${mm}`;
}

// ---- History Tab ----

function renderHistoryTab(bs: Bootstrap): string {
  const items = state.historySearch
    ? bs.history.filter(
        (h) =>
          h.title.toLowerCase().includes(state.historySearch.toLowerCase()) ||
          h.content.toLowerCase().includes(state.historySearch.toLowerCase()),
      )
    : bs.history;

  return `
    <div class="tab-content">
      <div class="search-bar">
        ${icon("search")}
        <input class="search-hi" type="text" placeholder="搜索历史记录..." value="${escapeHtml(state.historySearch)}" data-action="historySearch">
      </div>
      <section class="card">
        <div class="section-header">
          <h2>历史记录 (${items.length})</h2>
          <button class="btn-xs btn-danger-xs" data-action="clearHistory">清空</button>
        </div>
        <div class="history-section">
          ${
            items.length > 0
              ? items.map((h) => renderHistoryItem(h)).join("")
              : `<div class="empty-state">${icon("inbox", "empty-icon")} <p>暂无历史记录</p></div>`
          }
        </div>
      </section>
    </div>`;
}

function renderHistoryItem(item: HistoryItem): string {
  const hIconName =
    item.type === "conversation"
      ? "message"
      : item.type === "feedback"
        ? "starOutline"
        : "radio";
  const hIcon = icon(hIconName);
  const time = new Date(item.createdAt).toLocaleString("zh-CN");
  const isExpanded = state.expandedHistoryId === item.id;
  const showMenu = state.historyMenuId === item.id;

  return `
    <div class="history-item" data-history-id="${item.id}">
      <div class="history-icon">${hIcon}</div>
      <div class="history-content">
        <p class="history-title">${escapeHtml(item.title)}</p>
        <p class="history-meta">${item.type} · ${time}</p>
      </div>
      <div class="history-menu-trigger" data-menu-id="${item.id}">⋮</div>
      ${
        showMenu
          ? `
        <div class="history-menu">
          <button class="history-menu-item" data-action="deleteHistory" data-id="${item.id}">删除</button>
        </div>`
          : ""
      }
    </div>
    <div class="history-detail ${isExpanded ? "open" : ""}">
      <div class="detail-label">内容</div>
      <div class="detail-content">${escapeHtml(item.content)}</div>
    </div>`;
}

// ---- Shortcut Tab ----

function renderShortcutTab(bs: Bootstrap): string {
  return `
      <section class="card">
        <div class="section-header"><h2>快捷短语 (${bs.shortcuts.length})</h2></div>
        <div class="inline-form">
          <textarea class="text-area" id="newShortcutText" rows="2" placeholder="输入快捷短语...">${escapeHtml(state.newShortcutText)}</textarea>
          <button class="btn-grad btn-sm" data-action="shortcutAdd">添加</button>
        </div>
        <div class="shortcut-list" style="margin-top:8px">
          ${
            bs.shortcuts.length > 0
              ? bs.shortcuts.map((s) => renderShortcutItem(s)).join("")
              : `<div class="empty-state">${icon("inbox", "empty-icon")} <p>暂无快捷短语</p></div>`
          }
        </div>
      </section>`;
}

function renderShortcutItem(s: ShortcutItem): string {
  const isEditing = state.editingShortcutId === s.id;
  return `
    <div class="shortcut-item">
      ${
        isEditing
          ? `
        <textarea class="text-area" id="editShortcutText" rows="2">${escapeHtml(state.editingShortcutText)}</textarea>
        <div class="btn-group">
          <button class="btn-grad btn-xs" data-action="shortcutSaveEdit" data-id="${s.id}">保存</button>
          <button class="btn-secondary btn-xs" data-action="shortcutCancelEdit">取消</button>
        </div>`
          : `
        <p class="shortcut-text">${escapeHtml(s.content)}</p>
        <div class="item-actions">
          <button class="btn-xs" data-action="shortcutEdit" data-id="${s.id}" data-content="${escapeHtml(s.content)}">编辑</button>
          <button class="btn-xs btn-danger-xs" data-action="shortcutDelete" data-id="${s.id}">删除</button>
        </div>`
      }
    </div>`;
}

// ---- Template Tab ----

function renderTemplateTab(bs: Bootstrap): string {
  return `
      <section class="card">
        <div class="section-header"><h2>提示词模板 (${bs.templates.length})</h2></div>
        <div class="inline-form">
          <input class="text-input" id="newTemplateName" type="text" placeholder="模板名称" value="${escapeHtml(state.newTemplateName)}">
          <textarea class="text-area" id="newTemplateContent" rows="3" placeholder="模板内容...">${escapeHtml(state.newTemplateContent)}</textarea>
          <button class="btn-grad btn-sm" data-action="templateAdd">添加模板</button>
        </div>
        <div class="template-list" style="margin-top:8px">
          ${
            bs.templates.length > 0
              ? bs.templates.map((t) => renderTemplateItem(t)).join("")
              : `<div class="empty-state">${icon("inbox", "empty-icon")} <p>暂无模板</p></div>`
          }
        </div>
      </section>`;
}

function renderTemplateItem(t: TemplateItem): string {
  const isEditing = state.editingTemplateId === t.id;
  return `
    <div class="template-item">
      ${
        isEditing
          ? `
        <input class="text-input" id="editTemplateName" type="text" value="${escapeHtml(state.editingTemplateName)}">
        <textarea class="text-area" id="editTemplateContent" rows="3">${escapeHtml(state.editingTemplateContent)}</textarea>
        <div class="btn-group">
          <button class="btn-grad btn-xs" data-action="templateSaveEdit" data-id="${t.id}">保存</button>
          <button class="btn-secondary btn-xs" data-action="templateCancelEdit">取消</button>
        </div>`
          : `
        <div class="template-header">
          <p class="template-name">${escapeHtml(t.name)}</p>
          <div class="item-actions">
            <button class="btn-xs" data-action="templateEdit" data-id="${t.id}" data-name="${escapeHtml(t.name)}" data-content="${escapeHtml(t.content)}">编辑</button>
            <button class="btn-xs btn-danger-xs" data-action="templateDelete" data-id="${t.id}">删除</button>
          </div>
        </div>
        <p class="template-preview">${escapeHtml(t.content.slice(0, 80))}${t.content.length > 80 ? "..." : ""}</p>`
      }
    </div>`;
}

// ---- Tools Tab ----

function renderToolsTab(bs: Bootstrap): string {
  return `
    <div class="tab-content">
      ${renderShortcutTab(bs)}
      ${renderTemplateTab(bs)}
    </div>`;
}

// ---- Settings Tab ----

function renderSettingsTab(bs: Bootstrap): string {
  const { settings, status } = bs;
  return `
    <div class="tab-content">
      <section class="card">
        <div class="section-header"><h2>外观</h2></div>
        <div class="settings-section">
          <div class="setting-row">
            <span class="setting-label">主题</span>
            <select class="select-input" id="settingTheme">
              <option value="dark" ${settings.theme === "dark" ? "selected" : ""}>深色</option>
              <option value="light" ${settings.theme === "light" ? "selected" : ""}>浅色</option>
              <option value="auto" ${settings.theme === "auto" ? "selected" : ""}>自动</option>
            </select>
          </div>
          <div class="setting-row">
            <span class="setting-label">字号</span>
            <div class="slider-wrap">
              <input class="slider" id="settingFontSize" type="range" min="10" max="20" value="${settings.fontSize}">
              <span class="slider-val">${settings.fontSize}px</span>
            </div>
          </div>
          <div class="setting-row">
            <span class="setting-label">卡片透明度</span>
            <div class="slider-wrap">
              <input class="slider" id="settingCardOpacity" type="range" min="0" max="100" value="${settings.cardOpacity}">
              <span class="slider-val">${settings.cardOpacity}%</span>
            </div>
          </div>
          <div class="setting-row">
            <span class="setting-label">呼吸灯颜色</span>
            <input class="color-input" id="settingBreathColor" type="color" value="${settings.breathingLightColor}">
          </div>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>交互</h2></div>
        <div class="settings-section">
          <div class="setting-row">
            <span class="setting-label">Enter 发送</span>
            <label class="toggle">
              <input type="checkbox" id="settingEnterToSend" ${settings.enterToSend ? "checked" : ""}>
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">显示用户 Prompt</span>
            <label class="toggle">
              <input type="checkbox" id="settingShowUserPrompt" ${settings.showUserPrompt ? "checked" : ""}>
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">提示音</span>
            <select class="select-input" id="settingSoundAlert">
              <option value="none" ${settings.soundAlert === "none" ? "selected" : ""}>关闭</option>
              <option value="tada" ${settings.soundAlert === "tada" ? "selected" : ""}>Tada</option>
              <option value="ding" ${settings.soundAlert === "ding" ? "selected" : ""}>Ding</option>
              <option value="pop" ${settings.soundAlert === "pop" ? "selected" : ""}>Pop</option>
              <option value="chime" ${settings.soundAlert === "chime" ? "selected" : ""}>Chime</option>
            </select>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>历史记录</h2></div>
        <div class="settings-section">
          <div class="setting-row">
            <span class="setting-label">最大条数</span>
            <input class="num-input" id="settingHistoryLimit" type="number" value="${settings.historyLimit}" min="10" max="500">
          </div>
        </div>
        <div class="actions">
          <button class="btn-grad btn-sm" data-action="settingsSave">保存设置</button>
          <button class="btn-secondary btn-sm" data-action="settingsReset">恢复默认</button>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>配额获取</h2></div>
        <div class="settings-section">
          <div class="setting-row setting-row-col">
            <span class="setting-label">Firebase API Key <span class="hint">(通道B: 多账号配额，可选)</span></span>
            <input class="text-input" id="settingFirebaseApiKey" type="password"
              placeholder="AIzaSy..."
              value="${escapeHtml(settings.firebaseApiKey ?? "")}">
            <p class="hint" style="margin:0">从 Codeium/Windsurf 抓包获取，或留空仅用本地通道</p>
          </div>
        </div>
        <div class="actions">
          <button class="btn-grad btn-sm" data-action="settingsSave">保存配额设置</button>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>MCP 清理白名单</h2></div>
        <div class="settings-section">
          <p class="hint" style="margin:0 0 8px">以下 MCP 服务在执行「清理旧MCP配置」时将被保留，不会被删除。</p>
          <div class="whitelist-tags" id="mcpWhitelistTags">
            ${(settings.mcpWhitelist ?? []).map((name: string) => `
              <span class="whitelist-tag">
                ${escapeHtml(name)}
                <button class="whitelist-tag-remove" data-action="mcpWhitelistRemove" data-name="${escapeHtml(name)}" title="移除">×</button>
              </span>`).join("")}
          </div>
          <div class="whitelist-add-row">
            <input class="text-input text-input-sm" id="mcpWhitelistInput" placeholder="输入 MCP 名称…" style="flex:1">
            <button class="btn-secondary btn-sm" data-action="mcpWhitelistAdd">添加</button>
          </div>
        </div>
        <div class="actions">
          <button class="btn-grad btn-sm" data-action="settingsSave">保存白名单</button>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>诊断</h2></div>
        <div class="settings-section">
          <div class="setting-row">
            <span class="setting-label">服务端口</span>
            <span class="setting-value">${status.port}</span>
          </div>
          <div class="setting-row">
            <span class="setting-label">当前 IDE</span>
            <span class="setting-value">${escapeHtml(status.currentIde)}</span>
          </div>
          <div class="setting-row">
            <span class="setting-label">工具名称</span>
            <span class="setting-value">${escapeHtml(status.toolName)}</span>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>维护</h2></div>
        <div class="maintenance-grid">
          ${renderMaintenanceBtn("maintenanceCleanMcp", `${icon("broom")} 清理旧MCP配置`, "cleanMcp")}
          <p class="hint">清理MCP配置文件中的旧端口记录</p>
          ${renderMaintenanceBtn("maintenanceResetSettings", `${icon("reset")} 重置所有设置`, "resetSettings")}
          <p class="hint">恢复默认设置（清空快捷回复、模板等）</p>
          ${renderMaintenanceBtn("maintenanceRewriteRules", `${icon("fileText")} 重写规则文件`, "rewriteRules")}
          <p class="hint">重新写入AI反馈规则到工作区</p>
          ${renderMaintenanceBtn("maintenanceClearCache", `${icon("database")} 清理插件缓存`, "clearCache")}
          <p class="hint">清理历史记录、日志等缓存数据</p>
          ${renderMaintenanceBtn("maintenanceDiagnose", `${icon("wrench")} 诊断并修复`, "diagnose", true)}
          <p class="hint">检测服务器状态、MCP配置并自动修复</p>
          ${state.diagnoseResult ? renderDiagnoseCard(state.diagnoseResult) : ""}
        </div>
      </section>

      <section class="card">
        <div class="section-header"><h2>版本信息</h2></div>
        <div class="settings-section">
          <div class="setting-row">
            <span class="setting-label">当前版本</span>
            <span class="setting-value">rebuild-local</span>
          </div>
          <div class="setting-row">
            <span class="setting-label">服务状态</span>
            <span class="setting-value ${bs.status.running ? "text-ok" : "text-warn"}">${bs.status.running ? "正常运行" : "已停止"}</span>
          </div>
        </div>
        <div class="actions">
          <button class="btn-grad btn-sm" data-action="refresh">检查更新</button>
        </div>
        <p class="hint">当前为本地重建版本，更新功能需连接至远程服务器。</p>
      </section>
    </div>`;
}

// ---- Update Tab ----

function renderMaintenanceBtn(
  action: string,
  label: string,
  loadingKey: string,
  isGrad = false,
): string {
  const isLoading = state.maintenanceLoadingAction === loadingKey;
  const cls = isGrad ? "btn-maintenance btn-grad" : "btn-maintenance";
  return `<button class="${cls} ${isLoading ? "btn-loading" : ""}" data-action="${action}" ${isLoading ? "disabled" : ""}>${isLoading ? `<span class="btn-spinner"></span> 处理中...` : label}</button>`;
}

function renderDiagnoseCard(result: {
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  repaired?: number;
}): string {
  const ok = result.checks.filter((c) => c.ok).length;
  const fail = result.checks.filter((c) => !c.ok).length;
  return `
    <div class="diagnose-card">
      <div class="diagnose-header">
        <span class="diagnose-title">诊断报告</span>
        <span class="diagnose-summary">${ok} 通过${fail > 0 ? `, ${fail} 异常` : ""}${result.repaired ? `, ${result.repaired} 已修复` : ""}</span>
        <button class="btn-xs" data-action="dismissDiagnose">关闭</button>
      </div>
      <div class="diagnose-checks">
        ${result.checks
          .map(
            (c) => `
          <div class="diagnose-check ${c.ok ? "check-ok" : "check-fail"}">
            <span class="check-icon ${c.ok ? "text-ok" : "text-warn"}">${icon(c.ok ? "checkCircle" : "xCircle")}</span>
            <span class="check-name">${escapeHtml(c.name)}</span>
            <span class="check-detail">${escapeHtml(c.detail)}</span>
          </div>`,
          )
          .join("")}
      </div>
    </div>`;
}

// ---- MCP Dialog Card ----

function renderDialogCard(req: McpDialogRequest): string {
  const optionBtns = req.options?.length
    ? req.options
        .map(
          (opt, i) =>
            `<button class="btn-dialog-opt" data-action="dialogOption" data-idx="${i}" data-opt="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`,
        )
        .join('')
    : '';

  const charCount = state.dialogInput.length;
  const ts = new Date(req.receivedAt).toLocaleTimeString();
  const callLabel = state.dialogCallCount > 0 ? `第 ${state.dialogCallCount} 次调用` : '';
  const queueLen = state.responseQueue.length;
  const queueHint = queueLen > 0
    ? `<span class="dialog-queue-hint">队列剩余 ${queueLen} 条</span>`
    : '';

  return `
    <div class="dialog-card">
      <div class="dialog-header">
        <span class="dialog-icon">⏸</span>
        <span class="dialog-title">LLM 等待回复</span>
        ${callLabel ? `<span class="dialog-call-count">${callLabel}</span>` : ''}
        ${queueHint}
        <span class="dialog-ts">${ts}</span>
        <button class="btn-xs dialog-close-btn" data-action="dialogDismiss" title="取消对话 (Esc)">✕</button>
      </div>
      <div class="dialog-summary${req.isMarkdown ? ' dialog-summary-md' : ''}">${req.isMarkdown ? renderMd(req.summary) : escapeHtml(req.summary)}</div>
      ${optionBtns ? `<div class="dialog-options">${optionBtns}</div>` : ''}
      <div class="dialog-input-row">
        <textarea class="dialog-textarea" id="dialog-input" placeholder="输入回复… (Ctrl+Enter 发送, Esc 取消)" rows="3">${escapeHtml(state.dialogInput)}</textarea>
        <span class="dialog-charcount">${charCount} 字</span>
      </div>
      <div class="dialog-actions">
        <button class="btn-primary" data-action="dialogSubmit">✓ 发送 (Ctrl+Enter)</button>
      </div>
    </div>`;
}

function renderUpdateTab(bs: Bootstrap): string {
  return `
    <div class="tab-content">
      <section class="card">
        <div class="section-header"><h2>版本信息</h2></div>
        <div class="settings-section">
          <div class="setting-row">
            <span class="setting-label">当前版本</span>
            <span class="setting-value">rebuild-local</span>
          </div>
          <div class="setting-row">
            <span class="setting-label">服务状态</span>
            <span class="setting-value ${bs.status.running ? "text-success" : "text-danger"}">
              ${bs.status.running ? "正常运行" : "未运行"}
            </span>
          </div>
        </div>
        <div class="actions">
          <button class="btn-grad" data-action="refresh">检查更新</button>
        </div>
        <p class="hint">当前为本地重建版本，更新功能需连接至远程服务器。</p>
      </section>
    </div>`;
}

// ---- Debug Tab ----

function renderDebugTab(_bs: Bootstrap): string {
  const info = state.debugInfo;
  const loading = state.debugLoading;

  const patchBadge = !info
    ? ""
    : info.patchApplied
      ? `<span class="badge badge-ok">已打补丁</span>`
      : `<span class="badge badge-warn">未打补丁</span>`;

  const logLines = info?.logContent
    ? info.logContent
        .split("\n")
        .map((line) => {
          try {
            const r = JSON.parse(line) as {
              level: string;
              timestamp: string;
              message: string;
              extra?: Record<string, unknown>;
            };
            const lvlClass =
              r.level === "error"
                ? "log-error"
                : r.level === "warn"
                  ? "log-warn"
                  : r.level === "debug"
                    ? "log-debug"
                    : "log-info";
            const ts = r.timestamp
              ? r.timestamp.replace("T", " ").replace(/\.\d+Z$/, "")
              : "";
            const extraStr =
              r.extra && Object.keys(r.extra).length > 0
                ? " " + JSON.stringify(r.extra)
                : "";
            return `<span class="${lvlClass}">[${r.level?.toUpperCase() ?? "?"}] ${ts} ${escapeHtml(r.message)}${escapeHtml(extraStr)}</span>`;
          } catch {
            return `<span class="log-debug">${escapeHtml(line)}</span>`;
          }
        })
        .join("\n")
    : loading
      ? "加载中…"
      : '暂无日志，请点击"刷新"';

  return `
    <div class="tab-content">
      <section class="card dbg-card">
        <div class="section-header">
          <h2>调试面板</h2>
          <div class="btn-group">
            <button class="btn-xs btn-icon" data-action="testDialog" title="注入一个测试对话框，验证完整闭环">${icon("message")} 测试对话框</button>
            <button class="btn-xs btn-icon ${loading ? "disabled" : ""}" data-action="debugRefresh" ${loading ? "disabled" : ""}>${icon("refresh")} 刷新</button>
          </div>
        </div>

        <div class="dbg-section">
          <div class="dbg-row">
            <span class="dbg-label">${icon("fileText")} 日志文件</span>
            <div class="dbg-value-row">
              <span class="dbg-path">${info ? escapeHtml(info.logPath) : "—"}</span>
              ${info ? `<button class="btn-xs" data-action="debugCopyPath" title="复制路径">${icon("copy")} 复制路径</button>` : ""}
            </div>
          </div>
        </div>

        <div class="dbg-section">
          <div class="dbg-row">
            <span class="dbg-label">${icon("wrench")} Windsurf 补丁状态</span>
            <div class="dbg-value-row">
              ${patchBadge}
              ${info?.patchError ? `<span class="dbg-err">${escapeHtml(info.patchError)}</span>` : ""}
            </div>
          </div>
          ${
            info?.patchExtensionPath
              ? `
          <div class="dbg-row">
            <span class="dbg-label">extension.js 路径</span>
            <span class="dbg-path">${escapeHtml(info.patchExtensionPath)}</span>
          </div>`
              : ""
          }
          ${
            !info?.patchApplied && !loading
              ? `
          <p class="hint">补丁未应用时，切换账号会失败并显示"版本不匹配"。请点击账号页的"切换"按钮，插件会自动尝试打补丁。</p>`
              : ""
          }
        </div>

        <div class="dbg-section">
          <div class="dbg-row-header">
            <span class="dbg-label">${icon("fileText")} 最近 200 条日志</span>
            ${info?.logContent ? `<button class="btn-xs" data-action="debugCopyLogs">${icon("copy")} 复制给 AI</button>` : ""}
          </div>
          <pre class="dbg-log-area">${logLines}</pre>
        </div>
      </section>
    </div>`;
}

// ---- Bind Events ----

function bindEvents(): void {
  // Tab navigation
  document.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab as TabId | undefined;
      if (tab) {
        state.activeTab = tab;
        if (tab === "debug" && !state.debugInfo && !state.debugLoading) {
          state.debugLoading = true;
          vscode.postMessage({ type: "getDebugInfo" });
        }
        render();
      }
    });
  });

  // History search
  document
    .querySelector<HTMLInputElement>('[data-action="historySearch"]')
    ?.addEventListener("input", (e) => {
      state.historySearch = (e.target as HTMLInputElement).value;
      render();
    });

  // History item expand
  document.querySelectorAll<HTMLElement>(".history-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (
        (e.target as HTMLElement).closest(
          ".history-menu-trigger, .history-menu",
        )
      )
        return;
      const id = item.dataset.historyId;
      if (id) {
        state.expandedHistoryId =
          state.expandedHistoryId === id ? undefined : id;
        state.historyMenuId = undefined;
        render();
      }
    });
  });

  // History menu trigger
  document
    .querySelectorAll<HTMLElement>(".history-menu-trigger")
    .forEach((t) => {
      t.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = t.dataset.menuId;
        if (id) {
          state.historyMenuId = state.historyMenuId === id ? undefined : id;
          render();
        }
      });
    });

  // Slider live preview
  document.querySelectorAll<HTMLInputElement>(".slider").forEach((slider) => {
    slider.addEventListener("input", () => {
      const valEl = slider.nextElementSibling as HTMLElement | null;
      if (valEl) {
        valEl.textContent =
          slider.id === "settingFontSize"
            ? `${slider.value}px`
            : `${slider.value}%`;
      }
    });
  });

  // Dialog textarea: sync input to state.dialogInput for char count, Ctrl+Enter to submit
  const dialogTextarea = document.getElementById("dialog-input") as HTMLTextAreaElement | null;
  if (dialogTextarea) {
    dialogTextarea.addEventListener("input", () => {
      state.dialogInput = dialogTextarea.value;
      // Update char count without full re-render
      const counter = dialogTextarea.parentElement?.querySelector(".dialog-charcount");
      if (counter) counter.textContent = `${state.dialogInput.length} 字`;
    });
    dialogTextarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const response = dialogTextarea.value.trim();
        if (response && state.pendingDialog) {
          const sessionId = state.pendingDialog.sessionId;
          state.sentHistory.unshift({ text: response, sentAt: new Date().toLocaleTimeString(), mode: 'manual' });
          if (state.sentHistory.length > 10) state.sentHistory.pop();
          state.pendingDialog = undefined;
          state.dialogInput = "";
          vscode.postMessage({ type: "mcpDialogSubmit", value: { sessionId, response } });
          render();
        }
      }
      if (e.key === "Escape") {
        if (state.pendingDialog) {
          const dismissSid = state.pendingDialog.sessionId;
          vscode.postMessage({ type: "mcpDialogSubmit", value: { sessionId: dismissSid, response: "(cancelled)" } });
        }
        state.pendingDialog = undefined;
        state.dialogInput = "";
        render();
      }
    });
    // Focus textarea when dialog appears
    dialogTextarea.focus();
  }

  // Queue input: sync to state
  const queueTextarea = document.getElementById("queue-add-input") as HTMLTextAreaElement | null;
  if (queueTextarea) {
    queueTextarea.addEventListener("input", () => {
      state.queueInput = queueTextarea.value;
    });
    queueTextarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const val = queueTextarea.value.trim();
        if (val) {
          state.responseQueue.push(val);
          state.queueInput = "";
          render();
        }
      }
    });
  }

  // All data-action buttons
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
    if (el.tagName === "INPUT" || el.tagName === "SELECT") return;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      handleAction(el);
    });
  });
}

function handleAction(el: HTMLElement): void {
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    // MCP Dialog
    case "dialogSubmit": {
      const textarea = document.getElementById("dialog-input") as HTMLTextAreaElement | null;
      const response = (textarea?.value ?? state.dialogInput).trim();
      if (response && state.pendingDialog) {
        const sessionId = state.pendingDialog.sessionId;
        state.sentHistory.unshift({ text: response, sentAt: new Date().toLocaleTimeString(), mode: 'manual' });
        if (state.sentHistory.length > 10) state.sentHistory.pop();
        state.pendingDialog = undefined;
        state.dialogInput = "";
        vscode.postMessage({ type: "mcpDialogSubmit", value: { sessionId, response } });
        render();
      }
      break;
    }
    case "dialogOption": {
      const opt = el.dataset.opt;
      if (opt && state.pendingDialog) {
        const sessionId = state.pendingDialog.sessionId;
        state.sentHistory.unshift({ text: opt, sentAt: new Date().toLocaleTimeString(), mode: 'manual' });
        if (state.sentHistory.length > 10) state.sentHistory.pop();
        state.pendingDialog = undefined;
        state.dialogInput = "";
        vscode.postMessage({ type: "mcpDialogSubmit", value: { sessionId, response: opt } });
        render();
      }
      break;
    }
    case "dialogDismiss": {
      if (state.pendingDialog) {
        const dismissSid = state.pendingDialog.sessionId;
        vscode.postMessage({ type: "mcpDialogSubmit", value: { sessionId: dismissSid, response: "(cancelled)" } });
      }
      state.pendingDialog = undefined;
      state.dialogInput = "";
      render();
      break;
    }

    // Queue toggle (collapse/expand)
    case "queueToggle":
      state.queueCollapsed = !state.queueCollapsed;
      render();
      break;

    // Queue item edit
    case "queueEdit": {
      const editIdx = parseInt(el.dataset.idx ?? "", 10);
      if (!isNaN(editIdx) && editIdx >= 0 && editIdx < state.responseQueue.length) {
        state.editingQueueIdx = editIdx;
        state.editingQueueText = state.responseQueue[editIdx];
        render();
        document.getElementById(`queue-edit-${editIdx}`)?.focus();
      }
      break;
    }
    case "queueEditSave": {
      const saveIdx = parseInt(el.dataset.idx ?? "", 10);
      const editEl = document.getElementById(`queue-edit-${saveIdx}`) as HTMLTextAreaElement | null;
      const newText = (editEl?.value ?? state.editingQueueText).trim();
      if (!isNaN(saveIdx) && newText && saveIdx < state.responseQueue.length) {
        state.responseQueue[saveIdx] = newText;
        syncQueue();
      }
      state.editingQueueIdx = undefined;
      state.editingQueueText = "";
      render();
      break;
    }
    case "queueEditCancel":
      state.editingQueueIdx = undefined;
      state.editingQueueText = "";
      render();
      break;

    // Response Queue management
    case "queueAdd": {
      const qInput = (document.getElementById("queue-add-input") as HTMLTextAreaElement | null)?.value.trim()
        ?? state.queueInput.trim();
      if (qInput) {
        // Batch add: split by "---" separator line
        const items = qInput.split(/\n---\n/).map(s => s.trim()).filter(Boolean);
        for (const item of items) {
          state.responseQueue.push(item);
        }
        state.queueInput = "";
        syncQueue();
        render();
        if (items.length > 1) {
          showToast(`已批量添加 ${items.length} 条到队列`, "success");
        }
      }
      break;
    }
    case "queueRemove": {
      const idx = parseInt(el.dataset.idx ?? "", 10);
      if (!isNaN(idx) && idx >= 0 && idx < state.responseQueue.length) {
        state.responseQueue.splice(idx, 1);
        syncQueue();
        render();
      }
      break;
    }
    case "queueClear":
      if (state.responseQueue.length > 0 && confirm("确定清空队列？")) {
        state.responseQueue = [];
        syncQueue();
        render();
      }
      break;
    case "queueMoveUp": {
      const upIdx = parseInt(el.dataset.idx ?? "", 10);
      if (!isNaN(upIdx) && upIdx > 0 && upIdx < state.responseQueue.length) {
        [state.responseQueue[upIdx - 1], state.responseQueue[upIdx]] =
          [state.responseQueue[upIdx], state.responseQueue[upIdx - 1]];
        syncQueue();
        render();
      }
      break;
    }
    case "queueMoveDown": {
      const downIdx = parseInt(el.dataset.idx ?? "", 10);
      if (!isNaN(downIdx) && downIdx >= 0 && downIdx < state.responseQueue.length - 1) {
        [state.responseQueue[downIdx], state.responseQueue[downIdx + 1]] =
          [state.responseQueue[downIdx + 1], state.responseQueue[downIdx]];
        syncQueue();
        render();
      }
      break;
    }

    // Debug panel test dialog
    case "testDialog":
      vscode.postMessage({ type: "testDialog" });
      break;

    // General
    case "refresh":
      vscode.postMessage({ type: "refresh" });
      break;
    case "testFeedback":
      vscode.postMessage({ type: "testFeedback" });
      break;

    // Session
    case "sessionContinue":
      vscode.postMessage({ type: "sessionContinue" });
      break;
    case "sessionEnd":
      vscode.postMessage({ type: "sessionEnd" });
      break;

    // History
    case "clearHistory":
      vscode.postMessage({ type: "clearHistory" });
      break;
    case "deleteHistory":
      if (id) vscode.postMessage({ type: "deleteHistory", value: id });
      break;

    // Account
    case "toggleAddAccount":
      state.showAddAccount = !state.showAddAccount;
      state.showImportAccount = false;
      render();
      break;
    case "toggleImportAccount":
      state.showImportAccount = !state.showImportAccount;
      state.showAddAccount = false;
      render();
      break;
    case "accountAdd": {
      const line =
        (
          document.getElementById("addAccountLine") as HTMLInputElement
        )?.value.trim() ?? "";
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx > 0) {
        const email = line.slice(0, spaceIdx).trim();
        const password = line.slice(spaceIdx + 1).trim();
        if (email && password) {
          vscode.postMessage({
            type: "accountAdd",
            payload: { email, password },
          });
          state.addEmail = "";
          state.addPassword = "";
          state.showAddAccount = false;
        }
      }
      break;
    }
    case "accountImport": {
      const text =
        (document.getElementById("importText") as HTMLTextAreaElement)?.value ??
        "";
      if (text.trim()) {
        vscode.postMessage({ type: "accountImport", value: text });
        state.importText = "";
        state.showImportAccount = false;
      }
      break;
    }
    case "accountSwitch":
      if (id) {
        state.switchLoadingId = id;
        render();
        vscode.postMessage({ type: "accountSwitch", value: id });
      }
      break;
    case "accountDelete":
      if (id) {
        vscode.postMessage({ type: "accountDelete", value: id });
      }
      break;
    case "accountClear":
      vscode.postMessage({ type: "accountClear" });
      break;
    case "autoSwitchSave": {
      const enabled =
        (document.getElementById("autoSwitchEnabled") as HTMLInputElement)
          ?.checked ?? false;
      const switchOnDaily =
        (document.getElementById("autoSwitchOnDaily") as HTMLInputElement)
          ?.checked ?? true;
      const switchOnWeekly =
        (document.getElementById("autoSwitchOnWeekly") as HTMLInputElement)
          ?.checked ?? true;
      const threshold = parseInt(
        (document.getElementById("autoSwitchThreshold") as HTMLInputElement)
          ?.value ?? "5",
        10,
      );
      const creditWarning = parseInt(
        (document.getElementById("autoSwitchCreditWarning") as HTMLInputElement)
          ?.value ?? "3",
        10,
      );
      vscode.postMessage({
        type: "autoSwitchUpdate",
        payload: {
          enabled,
          switchOnDaily,
          switchOnWeekly,
          threshold,
          creditWarning,
        },
      });
      showToast("自动切换设置已保存");
      break;
    }
    case "resetMachineId":
      vscode.postMessage({ type: "resetMachineId" });
      break;
    case "quotaEditLimits": {
      const account = window.__QUOTE_BOOTSTRAP__.accounts.find(
        (a: WindsurfAccount) => a.id === id,
      );
      if (account) {
        state.editingQuotaAccountId = id;
        state.quotaDailyLimit = account.quota.dailyLimit;
        state.quotaWeeklyLimit = account.quota.weeklyLimit;
        render();
      }
      break;
    }
    case "quotaSaveLimits": {
      const dailyLimit = parseInt(
        (document.getElementById("quotaDailyLimit") as HTMLInputElement)
          ?.value ?? "0",
        10,
      );
      const weeklyLimit = parseInt(
        (document.getElementById("quotaWeeklyLimit") as HTMLInputElement)
          ?.value ?? "0",
        10,
      );
      if (id) {
        vscode.postMessage({
          type: "quotaSetLimits",
          payload: { id, dailyLimit, weeklyLimit },
        });
        state.editingQuotaAccountId = undefined;
        showToast("配额限额已保存");
      }
      break;
    }
    case "quotaCancelEdit":
      state.editingQuotaAccountId = undefined;
      render();
      break;

    // Shortcuts
    case "shortcutAdd": {
      const content =
        (
          document.getElementById("newShortcutText") as HTMLTextAreaElement
        )?.value.trim() ?? "";
      if (content) {
        vscode.postMessage({ type: "shortcutAdd", value: content });
        state.newShortcutText = "";
      }
      break;
    }
    case "shortcutEdit":
      state.editingShortcutId = id;
      state.editingShortcutText = el.dataset.content ?? "";
      render();
      break;
    case "shortcutSaveEdit": {
      const content =
        (
          document.getElementById("editShortcutText") as HTMLTextAreaElement
        )?.value.trim() ?? "";
      if (id && content) {
        vscode.postMessage({
          type: "shortcutUpdate",
          payload: { id, content },
        });
        state.editingShortcutId = undefined;
      }
      break;
    }
    case "shortcutCancelEdit":
      state.editingShortcutId = undefined;
      render();
      break;
    case "shortcutDelete":
      if (id) vscode.postMessage({ type: "shortcutDelete", value: id });
      break;

    // Templates
    case "templateAdd": {
      const name =
        (
          document.getElementById("newTemplateName") as HTMLInputElement
        )?.value.trim() ?? "";
      const content =
        (
          document.getElementById("newTemplateContent") as HTMLTextAreaElement
        )?.value.trim() ?? "";
      if (name && content) {
        vscode.postMessage({ type: "templateAdd", payload: { name, content } });
        state.newTemplateName = "";
        state.newTemplateContent = "";
      }
      break;
    }
    case "templateEdit":
      state.editingTemplateId = id;
      state.editingTemplateName = el.dataset.name ?? "";
      state.editingTemplateContent = el.dataset.content ?? "";
      render();
      break;
    case "templateSaveEdit": {
      const name =
        (
          document.getElementById("editTemplateName") as HTMLInputElement
        )?.value.trim() ?? "";
      const content =
        (
          document.getElementById("editTemplateContent") as HTMLTextAreaElement
        )?.value.trim() ?? "";
      if (id && name && content) {
        vscode.postMessage({
          type: "templateUpdate",
          payload: { id, name, content },
        });
        state.editingTemplateId = undefined;
      }
      break;
    }
    case "templateCancelEdit":
      state.editingTemplateId = undefined;
      render();
      break;
    case "templateDelete":
      if (id) vscode.postMessage({ type: "templateDelete", value: id });
      break;

    // Settings
    case "settingsSave": {
      const theme =
        (document.getElementById("settingTheme") as HTMLSelectElement)?.value ??
        "dark";
      const fontSize = parseInt(
        (document.getElementById("settingFontSize") as HTMLInputElement)
          ?.value ?? "14",
        10,
      );
      const cardOpacity = parseInt(
        (document.getElementById("settingCardOpacity") as HTMLInputElement)
          ?.value ?? "80",
        10,
      );
      const breathingLightColor =
        (document.getElementById("settingBreathColor") as HTMLInputElement)
          ?.value ?? "#00ff88";
      const enterToSend =
        (document.getElementById("settingEnterToSend") as HTMLInputElement)
          ?.checked ?? false;
      const showUserPrompt =
        (document.getElementById("settingShowUserPrompt") as HTMLInputElement)
          ?.checked ?? false;
      const soundAlert =
        (document.getElementById("settingSoundAlert") as HTMLSelectElement)
          ?.value ?? "none";
      const historyLimit = parseInt(
        (document.getElementById("settingHistoryLimit") as HTMLInputElement)
          ?.value ?? "30",
        10,
      );
      const firebaseApiKey =
        (
          document.getElementById("settingFirebaseApiKey") as HTMLInputElement
        )?.value?.trim() ?? "";
      const mcpWhitelist = Array.from(
        document.querySelectorAll<HTMLElement>(".whitelist-tag-remove")
      ).map(btn => btn.dataset.name ?? "").filter(Boolean);
      vscode.postMessage({
        type: "settingsUpdate",
        payload: {
          theme,
          fontSize,
          cardOpacity,
          breathingLightColor,
          enterToSend,
          showUserPrompt,
          soundAlert,
          historyLimit,
          firebaseApiKey,
          mcpWhitelist,
        },
      });
      showToast("设置已保存");
      break;
    }
    case "mcpWhitelistAdd": {
      const input = document.getElementById("mcpWhitelistInput") as HTMLInputElement | null;
      const name = input?.value.trim();
      if (!name) { showToast("请输入 MCP 名称", "error"); break; }
      const current = (window.__QUOTE_BOOTSTRAP__?.settings?.mcpWhitelist ?? []) as string[];
      if (current.includes(name)) { showToast("已在白名单中", "error"); break; }
      const updated = [...current, name];
      vscode.postMessage({ type: "settingsUpdate", payload: { mcpWhitelist: updated } });
      showToast(`已添加: ${name}`);
      break;
    }
    case "mcpWhitelistRemove": {
      const name = el.dataset.name ?? "";
      if (!name) break;
      const current = (window.__QUOTE_BOOTSTRAP__?.settings?.mcpWhitelist ?? []) as string[];
      const updated = current.filter((n: string) => n !== name);
      vscode.postMessage({ type: "settingsUpdate", payload: { mcpWhitelist: updated } });
      showToast(`已移除: ${name}`);
      break;
    }
    case "settingsReset":
      if (confirm("确定要恢复默认设置吗？")) {
        vscode.postMessage({ type: "settingsReset" });
      }
      break;

    // Quota fetch
    case "fetchAllQuotas":
      state.quotaFetching = true;
      render();
      vscode.postMessage({ type: "fetchAllQuotas" });
      break;
    case "fetchQuota":
      if (id) {
        state.quotaFetchingId = id;
        render();
        vscode.postMessage({ type: "fetchQuota", value: id });
      }
      break;

    // Maintenance
    case "maintenanceClearHistory":
      vscode.postMessage({ type: "maintenanceClearHistory" });
      break;
    case "maintenanceResetStats":
      vscode.postMessage({ type: "maintenanceResetStats" });
      showToast("统计已重置", "success");
      break;
    case "maintenanceCleanMcp":
      vscode.postMessage({ type: "maintenanceCleanMcp" });
      break;
    case "maintenanceResetSettings":
      vscode.postMessage({ type: "maintenanceResetSettings" });
      break;
    case "maintenanceRewriteRules":
      vscode.postMessage({ type: "maintenanceRewriteRules" });
      break;
    case "maintenanceClearCache":
      vscode.postMessage({ type: "maintenanceClearCache" });
      break;
    case "maintenanceDiagnose":
      state.diagnoseResult = undefined;
      vscode.postMessage({ type: "maintenanceDiagnose" });
      break;
    case "dismissDiagnose":
      state.diagnoseResult = undefined;
      render();
      break;

    // Debug
    case "debugRefresh":
      state.debugLoading = true;
      state.debugInfo = undefined;
      render();
      vscode.postMessage({ type: "getDebugInfo" });
      break;
    case "debugCopyPath":
      if (state.debugInfo?.logPath) {
        void navigator.clipboard.writeText(state.debugInfo.logPath).then(() => {
          showToast("路径已复制", "success");
        });
      }
      break;
    case "debugCopyLogs": {
      if (state.debugInfo) {
        const header = `=== Quote Debug Report ===\n日志路径: ${state.debugInfo.logPath}\nWindsurf 补丁: ${state.debugInfo.patchApplied ? "已应用" : "未应用"}${state.debugInfo.patchExtensionPath ? `\nextension.js: ${state.debugInfo.patchExtensionPath}` : ""}${state.debugInfo.patchError ? `\n补丁错误: ${state.debugInfo.patchError}` : ""}\n时间: ${new Date().toISOString()}\n\n=== 最近日志 ===\n`;
        void navigator.clipboard
          .writeText(header + state.debugInfo.logContent)
          .then(() => {
            showToast("日志已复制，可直接粘贴给 AI", "success", 4000);
          });
      }
      break;
    }
  }
}

// ---- Utilities ----

let _toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(
  msg: string,
  type: "info" | "success" | "error" = "info",
  duration?: number,
): void {
  if (_toastTimer !== undefined) {
    clearTimeout(_toastTimer);
    _toastTimer = undefined;
  }
  state.notification = msg;
  state.notificationType = type;
  render();
  const dur =
    duration ?? (type === "error" ? 5000 : msg.length > 30 ? 4000 : 2500);
  _toastTimer = setTimeout(() => {
    _toastTimer = undefined;
    state.notification = undefined;
    render();
  }, dur);
}

function syncQueue(): void {
  vscode.postMessage({ type: "queueSync", value: [...state.responseQueue] });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Minimal safe Markdown → HTML renderer (no external deps, XSS-safe).
 * Escapes HTML first, then applies inline formatting.
 */
function renderMd(raw: string): string {
  const lines = raw.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    let s = escapeHtml(line);
    // ## Heading
    if (s.startsWith('## ')) { out.push(`<strong class="md-h2">${s.slice(3)}</strong>`); continue; }
    if (s.startsWith('# ')) { out.push(`<strong class="md-h1">${s.slice(2)}</strong>`); continue; }
    // > blockquote
    if (s.startsWith('&gt; ')) { out.push(`<span class="md-quote">${s.slice(5)}</span>`); continue; }
    // inline: **bold**, *italic*, `code`
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
    out.push(s);
  }
  return out.join('<br>');
}

// ---- Message Handler ----

window.addEventListener("message", (event) => {
  const msg = event.data as { type: string; value: unknown };

  if (msg.type === "bootstrap") {
    window.__QUOTE_BOOTSTRAP__ = msg.value as Bootstrap;
    const pending = (msg.value as Bootstrap).status?.pendingDialog;
    if (pending) state.pendingDialog = pending;
    else if (!state.pendingDialog) state.pendingDialog = undefined;
    // Restore persisted queue (only if local queue is empty — avoid overwriting active edits)
    const savedQueue = (msg.value as Bootstrap).responseQueue;
    if (savedQueue && savedQueue.length > 0 && state.responseQueue.length === 0) {
      state.responseQueue = savedQueue;
    }
    render();
    return;
  }

  if (msg.type === "mcpDialog") {
    const req = msg.value as McpDialogRequest;
    state.dialogCallCount += 1;

    // Queue auto-reply: if there are queued responses, fire the first one immediately
    if (state.responseQueue.length > 0) {
      const autoReply = state.responseQueue.shift()!;
      syncQueue();
      state.sentHistory.unshift({ text: autoReply, sentAt: new Date().toLocaleTimeString(), mode: 'queue' });
      if (state.sentHistory.length > 10) state.sentHistory.pop();
      vscode.postMessage({ type: "mcpDialogSubmit", value: { sessionId: req.sessionId, response: autoReply } });
      showToast(`队列自动回复 [${state.dialogCallCount}]: "${autoReply.slice(0, 30)}${autoReply.length > 30 ? '…' : ''}"`, "success", 3500);
      render();
      return;
    }

    // No queue item — show dialog
    state.pendingDialog = req;
    state.dialogInput = "";
    state.activeTab = "status";
    render();
    return;
  }

  if (msg.type === "status") {
    window.__QUOTE_BOOTSTRAP__.status = msg.value as BridgeStatus & { pendingDialog?: McpDialogRequest };
    if (!(msg.value as { pendingDialog?: McpDialogRequest }).pendingDialog) {
      state.pendingDialog = undefined;
    }
    render();
    return;
  }

  if (msg.type === "waiting") {
    state.isWaiting = msg.value as boolean;
    render();
    return;
  }

  if (msg.type === "switchLoading") {
    if (!(msg.value as boolean)) {
      state.switchLoadingId = undefined;
    }
    render();
    return;
  }

  if (msg.type === "switchResult") {
    state.switchLoadingId = undefined;
    const r = msg.value as {
      success: boolean;
      needsRestart?: boolean;
      message: string;
    };
    showToast(
      r.message,
      r.success ? "success" : r.needsRestart ? "info" : "error",
    );
    return;
  }

  if (msg.type === "opResult") {
    const r = msg.value as { message: string };
    showToast(r.message, "success");
    return;
  }

  if (msg.type === "importResult") {
    const r = msg.value as { added: number; skipped: number };
    showToast(`导入完成：${r.added} 个成功，${r.skipped} 个跳过`, "success");
    return;
  }

  if (msg.type === "machineIdResult") {
    const r = msg.value as { success: boolean; message: string };
    showToast(r.message, r.success ? "success" : "error");
    return;
  }

  if (msg.type === "quotaFetchResult") {
    state.quotaFetching = false;
    state.quotaFetchingId = undefined;
    const r = msg.value as { success: boolean; error?: string };
    showToast(
      r.success ? "配额已更新" : `配额获取失败: ${r.error ?? "未知错误"}`,
      r.success ? "success" : "error",
    );
    return;
  }

  if (msg.type === "quotaFetchAllResult") {
    state.quotaFetching = false;
    const r = msg.value as {
      success: number;
      failed: number;
      errors: string[];
    };
    showToast(
      `配额刷新完成: ${r.success} 成功, ${r.failed} 失败`,
      r.failed > 0 ? "error" : "success",
    );
    return;
  }

  if (msg.type === "maintenanceLoading") {
    state.maintenanceLoadingAction = msg.value as string;
    render();
    return;
  }

  if (msg.type === "maintenanceResult") {
    state.maintenanceLoadingAction = undefined;
    const r = msg.value as {
      action?: string;
      cleaned?: number;
      details?: string[];
      written?: string[];
      failed?: string[];
    };
    if (r.cleaned !== undefined) {
      showToast(`清理完成: ${r.cleaned} 条旧配置已删除`, "success");
    } else if (r.written) {
      showToast(
        `规则写入完成: ${r.written.length} 个文件`,
        r.failed && r.failed.length > 0 ? "error" : "success",
      );
    } else if (r.action === "resetSettings") {
      showToast("所有设置已恢复默认", "success");
    } else if (r.action === "clearCache") {
      showToast("插件缓存已清理", "success");
    }
    return;
  }

  if (msg.type === "maintenanceError") {
    state.maintenanceLoadingAction = undefined;
    const r = msg.value as { action: string; error: string };
    showToast(`操作失败: ${r.error}`, "error", 5000);
    return;
  }

  if (msg.type === "debugInfo") {
    state.debugLoading = false;
    state.debugInfo = msg.value as {
      logPath: string;
      logContent: string;
      patchApplied: boolean;
      patchExtensionPath: string | null;
      patchError: string | null;
    };
    render();
    return;
  }

  if (msg.type === "diagnoseResult") {
    state.maintenanceLoadingAction = undefined;
    const r = msg.value as {
      checks: Array<{ name: string; ok: boolean; detail: string }>;
      repaired?: number;
    };
    state.diagnoseResult = r;
    const ok = r.checks.filter((c) => c.ok).length;
    const fail = r.checks.filter((c) => !c.ok).length;
    const repairText = r.repaired ? `, ${r.repaired} 项已修复` : "";
    showToast(
      `诊断完成: ${ok} 通过, ${fail} 异常${repairText}`,
      fail > 0 ? "error" : "success",
    );
    return;
  }
});

render();
