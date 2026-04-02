import './main.css';

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
  type: 'conversation' | 'feedback' | 'event';
  title: string;
  content: string;
  createdAt: string;
}

interface WindsurfAccount {
  id: string;
  email: string;
  plan: 'Trial' | 'Pro' | 'Enterprise' | 'Free' | 'Max' | 'Teams';
  creditsUsed: number;
  creditsTotal: number;
  quota: { dailyUsed: number; dailyLimit: number; dailyResetAt: string; weeklyUsed: number; weeklyLimit: number; weeklyResetAt: string };
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
  fetchedAt: string;
  source: 'local' | 'api' | 'apikey' | 'cache' | 'proto';
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
  warningLevel: 'ok' | 'warn' | 'critical';
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
  theme: 'dark' | 'light' | 'auto';
  panelPosition: 'right' | 'left' | 'bottom';
  feedbackHeight: number;
  inputHeight: number;
  fontSize: number;
  cardOpacity: number;
  breathingLightColor: string;
  enterToSend: boolean;
  showUserPrompt: boolean;
  historyLimit: number;
  soundAlert: 'none' | 'tada' | 'ding' | 'pop' | 'chime';
  firebaseApiKey: string;
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

interface Bootstrap {
  status: BridgeStatus;
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
}

declare global {
  interface Window {
    __AI_ECHO_BOOTSTRAP__: Bootstrap;
  }
}

// ---- State ----

type TabId = 'status' | 'account' | 'history' | 'shortcut' | 'template' | 'settings' | 'update';

const vscode = acquireVsCodeApi();

let state = {
  activeTab: 'status' as TabId,
  historySearch: '',
  isWaiting: false,
  expandedHistoryId: undefined as string | undefined,
  historyMenuId: undefined as string | undefined,
  // Account
  showAddAccount: false,
  showImportAccount: false,
  importText: '',
  addEmail: '',
  addPassword: '',
  // Shortcut
  editingShortcutId: undefined as string | undefined,
  editingShortcutText: '',
  newShortcutText: '',
  // Template
  editingTemplateId: undefined as string | undefined,
  editingTemplateName: '',
  editingTemplateContent: '',
  newTemplateName: '',
  newTemplateContent: '',
  // Quota editor
  editingQuotaAccountId: undefined as string | undefined,
  quotaDailyLimit: 0,
  quotaWeeklyLimit: 0,
  // Notification
  notification: undefined as string | undefined,
  // Quota fetching
  quotaFetching: false,
};

// ---- Render Root ----

function render(): void {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) return;
  const bs = window.__AI_ECHO_BOOTSTRAP__;
  root.innerHTML = `
    <main class="infinite-shell">
      ${renderHeader(bs)}
      ${renderTabNav()}
      ${renderActiveTab(bs)}
      ${state.notification ? `<div class="toast">${escapeHtml(state.notification)}</div>` : ''}
    </main>`;
  bindEvents();
}

// ---- Header ----

function renderHeader(bs: Bootstrap): string {
  return `
    <header class="infinite-header">
      <div>
        <p class="eyebrow">AI Echo</p>
        <h1>桥接服务 :${bs.status.port}</h1>
        <p class="subtle">${escapeHtml(bs.status.currentIde)} · ${escapeHtml(bs.status.toolName)}</p>
      </div>
      <span class="status-pill ${bs.status.running ? 'online' : 'offline'}">
        <span class="pill-dot"></span>
        ${bs.status.running ? '在线' : '离线'}
      </span>
    </header>`;
}

// ---- Tab Nav ----

function renderTabNav(): string {
  const tabs: { id: TabId; label: string }[] = [
    { id: 'status', label: '状态' },
    { id: 'account', label: '账号' },
    { id: 'history', label: '历史' },
    { id: 'shortcut', label: '快捷' },
    { id: 'template', label: '模板' },
    { id: 'settings', label: '设置' },
    { id: 'update', label: '更新' }
  ];
  return `
    <nav class="tab-nav">
      ${tabs.map(t => `
        <button class="tab-btn ${state.activeTab === t.id ? 'active' : ''}" data-tab="${t.id}">
          ${t.label}
        </button>`).join('')}
    </nav>`;
}

function renderActiveTab(bs: Bootstrap): string {
  switch (state.activeTab) {
    case 'status': return renderStatusTab(bs);
    case 'account': return renderAccountTab(bs);
    case 'history': return renderHistoryTab(bs);
    case 'shortcut': return renderShortcutTab(bs);
    case 'template': return renderTemplateTab(bs);
    case 'settings': return renderSettingsTab(bs);
    case 'update': return renderUpdateTab(bs);
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
      ${state.isWaiting ? `
        <div class="waiting-card">
          <div class="waiting-gl"><div class="waiting-spinner"></div></div>
          <span class="waiting-text">等待 AI 响应...</span>
        </div>` : ''}

      <section class="card">
        <div class="section-header"><h2>桥接服务</h2></div>
        <div class="service-status-row">
          <div class="service-indicator ${status.running ? 'running' : 'stopped'}">
            <span class="indicator-dot"></span>
            <span>${status.running ? '运行中' : '已停止'}</span>
          </div>
          <div class="service-meta">
            <span>SSE <b>${status.sseClientCount}</b></span>
            <span>消息 <b>${status.messageCount}</b></span>
            <span>配置 <b>${status.autoConfiguredPaths.length}</b></span>
          </div>
        </div>
        <div class="actions" style="margin-top:12px">
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
          ${status.autoConfiguredPaths.length > 0
            ? status.autoConfiguredPaths.map(p => `<li class="config-item">${escapeHtml(p)}</li>`).join('')
            : '<li class="empty-state">暂无自动配置路径</li>'}
        </ul>
      </section>
    </div>`;
}

// ---- Account Tab ----

function renderAccountTab(bs: Bootstrap): string {
  const { accounts, autoSwitch, quotaSnapshots } = bs;
  const snapshotMap = new Map(quotaSnapshots.map(s => [s.accountId, s]));
  const isFetching = bs.quotaFetching || state.quotaFetching;

  return `
    <div class="tab-content">
      ${accounts.length > 0 ? `
      <section class="card quota-dashboard">
        <div class="section-header">
          <h2>配额概览</h2>
          <button class="btn-grad btn-sm ${isFetching ? 'btn-loading' : ''}" data-action="fetchAllQuotas" ${isFetching ? 'disabled' : ''}>
            ${isFetching ? '<span class="spin-icon">↻</span> 查询中...' : '↻ 刷新全部配额'}
          </button>
        </div>
        <div class="quota-overview-grid">
          ${accounts.map(a => {
            const snap = snapshotMap.get(a.id);
            const rq = snap?.real;
            return renderQuotaMiniCard(a, snap, rq, bs.currentAccountId);
          }).join('')}
        </div>
      </section>` : ''}

      <section class="card">
        <div class="section-header">
          <h2>Windsurf 账号 (${accounts.length})</h2>
          <div class="btn-group">
            <button class="btn-xs" data-action="toggleAddAccount">+ 添加</button>
            <button class="btn-xs" data-action="toggleImportAccount">批量导入</button>
            ${accounts.length > 0 ? `<button class="btn-xs btn-danger-xs" data-action="accountClear">清空</button>` : ''}
          </div>
        </div>

        ${state.showAddAccount ? `
          <div class="inline-form">
            <input class="text-input" id="addEmail" type="text" placeholder="邮箱" value="${escapeHtml(state.addEmail)}">
            <input class="text-input" id="addPassword" type="password" placeholder="密码" value="${escapeHtml(state.addPassword)}">
            <div class="btn-group">
              <button class="btn-grad btn-sm" data-action="accountAdd">确认添加</button>
              <button class="btn-secondary btn-sm" data-action="toggleAddAccount">取消</button>
            </div>
          </div>` : ''}

        ${state.showImportAccount ? `
          <div class="inline-form">
            <p class="hint">每行一个账号，格式：邮箱----密码 或 邮箱:密码</p>
            <textarea class="text-area" id="importText" rows="5" placeholder="example@mail.com----password">${escapeHtml(state.importText)}</textarea>
            <div class="btn-group">
              <button class="btn-grad btn-sm" data-action="accountImport">导入</button>
              <button class="btn-secondary btn-sm" data-action="toggleImportAccount">取消</button>
            </div>
          </div>` : ''}

        <div class="account-list">
          ${accounts.length > 0
            ? accounts.map(a => renderAccountItem(a, bs.currentAccountId, snapshotMap.get(a.id))).join('')
            : '<p class="empty-state">暂无账号，点击"+ 添加"或"批量导入"</p>'}
        </div>
      </section>

      ${state.editingQuotaAccountId ? renderQuotaEditor(bs) : ''}

      <section class="card">
        <div class="section-header"><h2>自动切换</h2></div>
        <div class="settings-section">
          <div class="setting-row">
            <span class="setting-label">启用自动切换</span>
            <label class="toggle">
              <input type="checkbox" id="autoSwitchEnabled" ${autoSwitch.enabled ? 'checked' : ''}>
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">日配额触顶时切换</span>
            <label class="toggle">
              <input type="checkbox" id="autoSwitchOnDaily" ${autoSwitch.switchOnDaily ? 'checked' : ''}>
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">周配额触顶时切换</span>
            <label class="toggle">
              <input type="checkbox" id="autoSwitchOnWeekly" ${autoSwitch.switchOnWeekly ? 'checked' : ''}>
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

function renderQuotaMiniCard(a: WindsurfAccount, snap: QuotaSnapshot | undefined, rq: RealQuotaInfo | undefined, currentId?: string): string {
  const isCurrent = a.id === currentId || a.isActive;
  const hasData = !!rq;
  const dailyPct = hasData ? rq!.dailyRemainingPercent : null;
  const weeklyPct = hasData ? rq!.weeklyRemainingPercent : null;
  const noDataColor = 'var(--muted)';
  const dailyColor = !hasData ? noDataColor : (dailyPct! > 30 ? 'var(--accent)' : dailyPct! > 10 ? 'var(--warning)' : 'var(--danger)');
  const weeklyColor = !hasData ? noDataColor : (weeklyPct! > 30 ? 'var(--accent)' : weeklyPct! > 10 ? 'var(--warning)' : 'var(--danger)');
  const plan = rq?.planName ?? a.plan;
  const circumference = 2 * Math.PI * 20;
  const dailyDash = hasData ? (circumference - (dailyPct! / 100) * circumference) : circumference;
  const weeklyDash = hasData ? (circumference - (weeklyPct! / 100) * circumference) : circumference;
  const dailyLabel = hasData ? `${dailyPct}%` : '–';
  const weeklyLabel = hasData ? `${weeklyPct}%` : '–';
  const dailyTitle = hasData ? `日配额 ${dailyPct}%` : '日配额未获取，点击刷新';
  const weeklyTitle = hasData ? `周配额 ${weeklyPct}%` : '周配额未获取，点击刷新';
  const srcMap: Record<string, string> = { local: '本地', api: 'API', apikey: 'Key', cache: '缓存', proto: 'Proto' };
  const sourceLabel = rq ? (srcMap[rq.source] ?? rq.source) : '';
  const fetchedTime = rq?.fetchedAt ? new Date(rq.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';

  return `
    <div class="quota-mini-card ${isCurrent ? 'current' : ''} ${!hasData ? 'no-data' : ''} ${snap?.warningLevel === 'critical' ? 'critical' : snap?.warningLevel === 'warn' ? 'warn' : ''}">
      <div class="qmc-header">
        <span class="qmc-email" title="${escapeHtml(a.email)}">${escapeHtml(a.email.split('@')[0])}</span>
        <span class="qmc-plan plan-${plan.toLowerCase()}">${plan}</span>
      </div>
      <div class="qmc-rings">
        <div class="qmc-ring-wrap" title="${dailyTitle}">
          <svg class="qmc-ring" viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="20" fill="none" stroke="var(--border)" stroke-width="3.5"/>
            <circle cx="24" cy="24" r="20" fill="none" stroke="${dailyColor}" stroke-width="3.5"
              stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${dailyDash.toFixed(1)}"
              stroke-linecap="round" transform="rotate(-90 24 24)" opacity="${hasData ? 1 : 0.35}"/>
          </svg>
          <span class="qmc-ring-label ${!hasData ? 'muted' : ''}">${dailyLabel}</span>
          <span class="qmc-ring-sub">日</span>
        </div>
        <div class="qmc-ring-wrap" title="${weeklyTitle}">
          <svg class="qmc-ring" viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="20" fill="none" stroke="var(--border)" stroke-width="3.5"/>
            <circle cx="24" cy="24" r="20" fill="none" stroke="${weeklyColor}" stroke-width="3.5"
              stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${weeklyDash.toFixed(1)}"
              stroke-linecap="round" transform="rotate(-90 24 24)" opacity="${hasData ? 1 : 0.35}"/>
          </svg>
          <span class="qmc-ring-label ${!hasData ? 'muted' : ''}">${weeklyLabel}</span>
          <span class="qmc-ring-sub">周</span>
        </div>
      </div>
      ${rq ? `
      <div class="qmc-detail">
        <span class="qmc-stat">消息 ${rq.remainingMessages}/${rq.messages}</span>
        <span class="qmc-stat">Flow ${rq.remainingFlowActions}/${rq.flowActions}</span>
      </div>
      <div class="qmc-meta">
        <span class="qmc-source">${sourceLabel}</span>
        <span class="qmc-time">${fetchedTime}</span>
      </div>` : `
      <div class="qmc-detail">
        <span class="qmc-no-data">点击"刷新全部配额"获取</span>
      </div>`}
      ${isCurrent ? '<div class="qmc-current-badge">当前</div>' : ''}
    </div>`;
}

function renderAccountItem(a: WindsurfAccount, currentId?: string, snapshot?: QuotaSnapshot): string {
  const isCurrent = a.id === currentId || a.isActive;
  const planColors: Record<string, string> = {
    Pro: 'var(--accent)', Max: '#8b5cf6', Enterprise: '#a855f7', Teams: '#06b6d4'
  };
  const planColor = planColors[a.plan] ?? 'var(--muted)';
  const q = snapshot;

  return `
    <div class="account-item ${isCurrent ? 'active' : ''} ${q?.warningLevel === 'critical' ? 'quota-critical' : q?.warningLevel === 'warn' ? 'quota-warn' : ''}">
      <div class="account-avatar" style="background: linear-gradient(135deg, ${planColor}, #6366f1)">
        ${a.email[0].toUpperCase()}
      </div>
      <div class="account-info">
        <p class="account-name">${escapeHtml(a.email)}</p>
        <p class="account-meta">
          <span class="plan-badge" style="color:${planColor}">${a.plan}</span>
          ${isCurrent ? ' · <span class="badge-active">当前</span>' : ''}
        </p>
        ${q && q.dailyLimit > 0 ? `
          <div class="quota-bars">
            <div class="quota-row">
              <span class="quota-label">日</span>
              <div class="credit-bar"><div class="credit-fill" style="width:${pct(q.dailyUsed, q.dailyLimit)}%; background:${quotaColor(q.dailyUsed, q.dailyLimit)}"></div></div>
              <span class="quota-nums">${q.dailyRemaining}/${q.dailyLimit}</span>
              <span class="quota-reset">${q.dailyResetIn}</span>
            </div>
            <div class="quota-row">
              <span class="quota-label">周</span>
              <div class="credit-bar"><div class="credit-fill" style="width:${pct(q.weeklyUsed, q.weeklyLimit)}%; background:${quotaColor(q.weeklyUsed, q.weeklyLimit)}"></div></div>
              <span class="quota-nums">${q.weeklyRemaining}/${q.weeklyLimit}</span>
              <span class="quota-reset">${q.weeklyResetIn}</span>
            </div>
          </div>` : a.creditsTotal > 0 ? `
          <div class="quota-bars">
            <div class="quota-row">
              <span class="quota-label">额度</span>
              <div class="credit-bar"><div class="credit-fill" style="width:${pct(a.creditsUsed, a.creditsTotal)}%; background:${quotaColor(a.creditsUsed, a.creditsTotal)}"></div></div>
              <span class="quota-nums">${a.creditsTotal - a.creditsUsed}/${a.creditsTotal}</span>
            </div>
          </div>` : ''}
      </div>
      <div class="account-actions">
        ${!isCurrent ? `<button class="btn-xs" data-action="accountSwitch" data-id="${a.id}">切换</button>` : ''}
        <button class="btn-xs" data-action="quotaEditLimits" data-id="${a.id}">配额</button>
        <button class="btn-xs btn-danger-xs" data-action="accountDelete" data-id="${a.id}">删除</button>
      </div>
    </div>`;
}

function renderQuotaEditor(bs: Bootstrap): string {
  const account = bs.accounts.find(a => a.id === state.editingQuotaAccountId);
  if (!account) return '';
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

function pct(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
}

function quotaColor(used: number, total: number): string {
  if (total <= 0) return 'var(--accent)';
  const ratio = used / total;
  if (ratio >= 0.9) return 'var(--danger)';
  if (ratio >= 0.7) return 'var(--warning)';
  return 'var(--accent)';
}

// ---- History Tab ----

function renderHistoryTab(bs: Bootstrap): string {
  const items = state.historySearch
    ? bs.history.filter(h =>
        h.title.toLowerCase().includes(state.historySearch.toLowerCase()) ||
        h.content.toLowerCase().includes(state.historySearch.toLowerCase()))
    : bs.history;

  return `
    <div class="tab-content">
      <div class="search-bar">
        <span>🔍</span>
        <input class="search-hi" type="text" placeholder="搜索历史记录..." value="${escapeHtml(state.historySearch)}" data-action="historySearch">
      </div>
      <section class="card">
        <div class="section-header">
          <h2>历史记录 (${items.length})</h2>
          <button class="btn-xs btn-danger-xs" data-action="clearHistory">清空</button>
        </div>
        <div class="history-section">
          ${items.length > 0
            ? items.map(h => renderHistoryItem(h)).join('')
            : '<p class="empty-state">暂无历史记录</p>'}
        </div>
      </section>
    </div>`;
}

function renderHistoryItem(item: HistoryItem): string {
  const icon = item.type === 'conversation' ? '💬' : item.type === 'feedback' ? '⭐' : '📡';
  const time = new Date(item.createdAt).toLocaleString('zh-CN');
  const isExpanded = state.expandedHistoryId === item.id;
  const showMenu = state.historyMenuId === item.id;

  return `
    <div class="history-item" data-history-id="${item.id}">
      <div class="history-icon">${icon}</div>
      <div class="history-content">
        <p class="history-title">${escapeHtml(item.title)}</p>
        <p class="history-meta">${item.type} · ${time}</p>
      </div>
      <div class="history-menu-trigger" data-menu-id="${item.id}">⋮</div>
      ${showMenu ? `
        <div class="history-menu">
          <button class="history-menu-item" data-action="deleteHistory" data-id="${item.id}">删除</button>
        </div>` : ''}
    </div>
    <div class="history-detail ${isExpanded ? 'open' : ''}">
      <div class="detail-label">内容</div>
      <div class="detail-content">${escapeHtml(item.content)}</div>
    </div>`;
}

// ---- Shortcut Tab ----

function renderShortcutTab(bs: Bootstrap): string {
  return `
    <div class="tab-content">
      <section class="card">
        <div class="section-header"><h2>快捷短语 (${bs.shortcuts.length})</h2></div>
        <div class="inline-form">
          <textarea class="text-area" id="newShortcutText" rows="2" placeholder="输入快捷短语...">${escapeHtml(state.newShortcutText)}</textarea>
          <button class="btn-grad btn-sm" data-action="shortcutAdd">添加</button>
        </div>
        <div class="shortcut-list" style="margin-top:12px">
          ${bs.shortcuts.length > 0
            ? bs.shortcuts.map(s => renderShortcutItem(s)).join('')
            : '<p class="empty-state">暂无快捷短语</p>'}
        </div>
      </section>
    </div>`;
}

function renderShortcutItem(s: ShortcutItem): string {
  const isEditing = state.editingShortcutId === s.id;
  return `
    <div class="shortcut-item">
      ${isEditing ? `
        <textarea class="text-area" id="editShortcutText" rows="2">${escapeHtml(state.editingShortcutText)}</textarea>
        <div class="btn-group">
          <button class="btn-grad btn-xs" data-action="shortcutSaveEdit" data-id="${s.id}">保存</button>
          <button class="btn-secondary btn-xs" data-action="shortcutCancelEdit">取消</button>
        </div>` : `
        <p class="shortcut-text">${escapeHtml(s.content)}</p>
        <div class="item-actions">
          <button class="btn-xs" data-action="shortcutEdit" data-id="${s.id}" data-content="${escapeHtml(s.content)}">编辑</button>
          <button class="btn-xs btn-danger-xs" data-action="shortcutDelete" data-id="${s.id}">删除</button>
        </div>`}
    </div>`;
}

// ---- Template Tab ----

function renderTemplateTab(bs: Bootstrap): string {
  return `
    <div class="tab-content">
      <section class="card">
        <div class="section-header"><h2>提示词模板 (${bs.templates.length})</h2></div>
        <div class="inline-form">
          <input class="text-input" id="newTemplateName" type="text" placeholder="模板名称" value="${escapeHtml(state.newTemplateName)}">
          <textarea class="text-area" id="newTemplateContent" rows="3" placeholder="模板内容...">${escapeHtml(state.newTemplateContent)}</textarea>
          <button class="btn-grad btn-sm" data-action="templateAdd">添加模板</button>
        </div>
        <div class="template-list" style="margin-top:12px">
          ${bs.templates.length > 0
            ? bs.templates.map(t => renderTemplateItem(t)).join('')
            : '<p class="empty-state">暂无模板</p>'}
        </div>
      </section>
    </div>`;
}

function renderTemplateItem(t: TemplateItem): string {
  const isEditing = state.editingTemplateId === t.id;
  return `
    <div class="template-item">
      ${isEditing ? `
        <input class="text-input" id="editTemplateName" type="text" value="${escapeHtml(state.editingTemplateName)}">
        <textarea class="text-area" id="editTemplateContent" rows="3">${escapeHtml(state.editingTemplateContent)}</textarea>
        <div class="btn-group">
          <button class="btn-grad btn-xs" data-action="templateSaveEdit" data-id="${t.id}">保存</button>
          <button class="btn-secondary btn-xs" data-action="templateCancelEdit">取消</button>
        </div>` : `
        <div class="template-header">
          <p class="template-name">${escapeHtml(t.name)}</p>
          <div class="item-actions">
            <button class="btn-xs" data-action="templateEdit" data-id="${t.id}" data-name="${escapeHtml(t.name)}" data-content="${escapeHtml(t.content)}">编辑</button>
            <button class="btn-xs btn-danger-xs" data-action="templateDelete" data-id="${t.id}">删除</button>
          </div>
        </div>
        <p class="template-preview">${escapeHtml(t.content.slice(0, 80))}${t.content.length > 80 ? '...' : ''}</p>`}
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
              <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>深色</option>
              <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>浅色</option>
              <option value="auto" ${settings.theme === 'auto' ? 'selected' : ''}>自动</option>
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
              <input type="checkbox" id="settingEnterToSend" ${settings.enterToSend ? 'checked' : ''}>
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">显示用户 Prompt</span>
            <label class="toggle">
              <input type="checkbox" id="settingShowUserPrompt" ${settings.showUserPrompt ? 'checked' : ''}>
              <span class="toggle-track"></span>
            </label>
          </div>
          <div class="setting-row">
            <span class="setting-label">提示音</span>
            <select class="select-input" id="settingSoundAlert">
              <option value="none" ${settings.soundAlert === 'none' ? 'selected' : ''}>关闭</option>
              <option value="tada" ${settings.soundAlert === 'tada' ? 'selected' : ''}>Tada</option>
              <option value="ding" ${settings.soundAlert === 'ding' ? 'selected' : ''}>Ding</option>
              <option value="pop" ${settings.soundAlert === 'pop' ? 'selected' : ''}>Pop</option>
              <option value="chime" ${settings.soundAlert === 'chime' ? 'selected' : ''}>Chime</option>
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
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:6px">
            <span class="setting-label">Firebase API Key <span class="hint" style="font-size:11px">(通道B: 多账号配额，可选)</span></span>
            <input class="text-input" id="settingFirebaseApiKey" type="password"
              placeholder="AIzaSy..."
              value="${escapeHtml(settings.firebaseApiKey ?? '')}">
            <p class="hint" style="font-size:11px;margin:0">从 Codeium/Windsurf 抓包获取，或留空仅用本地通道</p>
          </div>
        </div>
        <div class="actions">
          <button class="btn-grad btn-sm" data-action="settingsSave">保存配额设置</button>
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
        <div class="actions">
          <button class="btn-secondary" data-action="maintenanceClearHistory">清空历史</button>
          <button class="btn-secondary" data-action="maintenanceResetStats">重置统计</button>
        </div>
      </section>
    </div>`;
}

// ---- Update Tab ----

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
            <span class="setting-value ${bs.status.running ? 'text-success' : 'text-danger'}">
              ${bs.status.running ? '正常运行' : '未运行'}
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

// ---- Bind Events ----

function bindEvents(): void {
  // Tab navigation
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab as TabId | undefined;
      if (tab) { state.activeTab = tab; render(); }
    });
  });

  // History search
  document.querySelector<HTMLInputElement>('[data-action="historySearch"]')
    ?.addEventListener('input', e => {
      state.historySearch = (e.target as HTMLInputElement).value;
      render();
    });

  // History item expand
  document.querySelectorAll<HTMLElement>('.history-item').forEach(item => {
    item.addEventListener('click', e => {
      if ((e.target as HTMLElement).closest('.history-menu-trigger, .history-menu')) return;
      const id = item.dataset.historyId;
      if (id) {
        state.expandedHistoryId = state.expandedHistoryId === id ? undefined : id;
        state.historyMenuId = undefined;
        render();
      }
    });
  });

  // History menu trigger
  document.querySelectorAll<HTMLElement>('.history-menu-trigger').forEach(t => {
    t.addEventListener('click', e => {
      e.stopPropagation();
      const id = t.dataset.menuId;
      if (id) { state.historyMenuId = state.historyMenuId === id ? undefined : id; render(); }
    });
  });

  // Slider live preview
  document.querySelectorAll<HTMLInputElement>('.slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const valEl = slider.nextElementSibling as HTMLElement | null;
      if (valEl) {
        valEl.textContent = slider.id === 'settingFontSize' ? `${slider.value}px` : `${slider.value}%`;
      }
    });
  });

  // All data-action buttons
  document.querySelectorAll<HTMLElement>('[data-action]').forEach(el => {
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    el.addEventListener('click', e => {
      e.stopPropagation();
      handleAction(el);
    });
  });
}

function handleAction(el: HTMLElement): void {
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    // General
    case 'refresh':
      vscode.postMessage({ type: 'refresh' });
      break;
    case 'testFeedback':
      vscode.postMessage({ type: 'testFeedback' });
      break;

    // Session
    case 'sessionContinue':
      vscode.postMessage({ type: 'sessionContinue' });
      break;
    case 'sessionEnd':
      vscode.postMessage({ type: 'sessionEnd' });
      break;

    // History
    case 'clearHistory':
      vscode.postMessage({ type: 'clearHistory' });
      break;
    case 'deleteHistory':
      if (id) vscode.postMessage({ type: 'deleteHistory', value: id });
      break;

    // Account
    case 'toggleAddAccount':
      state.showAddAccount = !state.showAddAccount;
      state.showImportAccount = false;
      render();
      break;
    case 'toggleImportAccount':
      state.showImportAccount = !state.showImportAccount;
      state.showAddAccount = false;
      render();
      break;
    case 'accountAdd': {
      const email = (document.getElementById('addEmail') as HTMLInputElement)?.value.trim() ?? '';
      const password = (document.getElementById('addPassword') as HTMLInputElement)?.value.trim() ?? '';
      if (email && password) {
        vscode.postMessage({ type: 'accountAdd', payload: { email, password } });
        state.addEmail = '';
        state.addPassword = '';
        state.showAddAccount = false;
      }
      break;
    }
    case 'accountImport': {
      const text = (document.getElementById('importText') as HTMLTextAreaElement)?.value ?? '';
      if (text.trim()) {
        vscode.postMessage({ type: 'accountImport', value: text });
        state.importText = '';
        state.showImportAccount = false;
      }
      break;
    }
    case 'accountSwitch':
      if (id) vscode.postMessage({ type: 'accountSwitch', value: id });
      break;
    case 'accountDelete':
      if (id) vscode.postMessage({ type: 'accountDelete', value: id });
      break;
    case 'accountClear':
      vscode.postMessage({ type: 'accountClear' });
      break;
    case 'autoSwitchSave': {
      const enabled = (document.getElementById('autoSwitchEnabled') as HTMLInputElement)?.checked ?? false;
      const switchOnDaily = (document.getElementById('autoSwitchOnDaily') as HTMLInputElement)?.checked ?? true;
      const switchOnWeekly = (document.getElementById('autoSwitchOnWeekly') as HTMLInputElement)?.checked ?? true;
      const threshold = parseInt((document.getElementById('autoSwitchThreshold') as HTMLInputElement)?.value ?? '5', 10);
      const creditWarning = parseInt((document.getElementById('autoSwitchCreditWarning') as HTMLInputElement)?.value ?? '3', 10);
      vscode.postMessage({ type: 'autoSwitchUpdate', payload: { enabled, switchOnDaily, switchOnWeekly, threshold, creditWarning } });
      showToast('自动切换设置已保存');
      break;
    }
    case 'resetMachineId':
      vscode.postMessage({ type: 'resetMachineId' });
      break;
    case 'quotaEditLimits': {
      const account = window.__AI_ECHO_BOOTSTRAP__.accounts.find(a => a.id === id);
      if (account) {
        state.editingQuotaAccountId = id;
        state.quotaDailyLimit = account.quota.dailyLimit;
        state.quotaWeeklyLimit = account.quota.weeklyLimit;
        render();
      }
      break;
    }
    case 'quotaSaveLimits': {
      const dailyLimit = parseInt((document.getElementById('quotaDailyLimit') as HTMLInputElement)?.value ?? '0', 10);
      const weeklyLimit = parseInt((document.getElementById('quotaWeeklyLimit') as HTMLInputElement)?.value ?? '0', 10);
      if (id) {
        vscode.postMessage({ type: 'quotaSetLimits', payload: { id, dailyLimit, weeklyLimit } });
        state.editingQuotaAccountId = undefined;
        showToast('配额限额已保存');
      }
      break;
    }
    case 'quotaCancelEdit':
      state.editingQuotaAccountId = undefined;
      render();
      break;

    // Shortcuts
    case 'shortcutAdd': {
      const content = (document.getElementById('newShortcutText') as HTMLTextAreaElement)?.value.trim() ?? '';
      if (content) {
        vscode.postMessage({ type: 'shortcutAdd', value: content });
        state.newShortcutText = '';
      }
      break;
    }
    case 'shortcutEdit':
      state.editingShortcutId = id;
      state.editingShortcutText = el.dataset.content ?? '';
      render();
      break;
    case 'shortcutSaveEdit': {
      const content = (document.getElementById('editShortcutText') as HTMLTextAreaElement)?.value.trim() ?? '';
      if (id && content) {
        vscode.postMessage({ type: 'shortcutUpdate', payload: { id, content } });
        state.editingShortcutId = undefined;
      }
      break;
    }
    case 'shortcutCancelEdit':
      state.editingShortcutId = undefined;
      render();
      break;
    case 'shortcutDelete':
      if (id) vscode.postMessage({ type: 'shortcutDelete', value: id });
      break;

    // Templates
    case 'templateAdd': {
      const name = (document.getElementById('newTemplateName') as HTMLInputElement)?.value.trim() ?? '';
      const content = (document.getElementById('newTemplateContent') as HTMLTextAreaElement)?.value.trim() ?? '';
      if (name && content) {
        vscode.postMessage({ type: 'templateAdd', payload: { name, content } });
        state.newTemplateName = '';
        state.newTemplateContent = '';
      }
      break;
    }
    case 'templateEdit':
      state.editingTemplateId = id;
      state.editingTemplateName = el.dataset.name ?? '';
      state.editingTemplateContent = el.dataset.content ?? '';
      render();
      break;
    case 'templateSaveEdit': {
      const name = (document.getElementById('editTemplateName') as HTMLInputElement)?.value.trim() ?? '';
      const content = (document.getElementById('editTemplateContent') as HTMLTextAreaElement)?.value.trim() ?? '';
      if (id && name && content) {
        vscode.postMessage({ type: 'templateUpdate', payload: { id, name, content } });
        state.editingTemplateId = undefined;
      }
      break;
    }
    case 'templateCancelEdit':
      state.editingTemplateId = undefined;
      render();
      break;
    case 'templateDelete':
      if (id) vscode.postMessage({ type: 'templateDelete', value: id });
      break;

    // Settings
    case 'settingsSave': {
      const theme = (document.getElementById('settingTheme') as HTMLSelectElement)?.value ?? 'dark';
      const fontSize = parseInt((document.getElementById('settingFontSize') as HTMLInputElement)?.value ?? '14', 10);
      const cardOpacity = parseInt((document.getElementById('settingCardOpacity') as HTMLInputElement)?.value ?? '80', 10);
      const breathingLightColor = (document.getElementById('settingBreathColor') as HTMLInputElement)?.value ?? '#00ff88';
      const enterToSend = (document.getElementById('settingEnterToSend') as HTMLInputElement)?.checked ?? false;
      const showUserPrompt = (document.getElementById('settingShowUserPrompt') as HTMLInputElement)?.checked ?? false;
      const soundAlert = (document.getElementById('settingSoundAlert') as HTMLSelectElement)?.value ?? 'none';
      const historyLimit = parseInt((document.getElementById('settingHistoryLimit') as HTMLInputElement)?.value ?? '30', 10);
      const firebaseApiKey = (document.getElementById('settingFirebaseApiKey') as HTMLInputElement)?.value?.trim() ?? '';
      vscode.postMessage({ type: 'settingsUpdate', payload: { theme, fontSize, cardOpacity, breathingLightColor, enterToSend, showUserPrompt, soundAlert, historyLimit, firebaseApiKey } });
      showToast('设置已保存');
      break;
    }
    case 'settingsReset':
      vscode.postMessage({ type: 'settingsReset' });
      break;

    // Quota fetch
    case 'fetchAllQuotas':
      state.quotaFetching = true;
      render();
      vscode.postMessage({ type: 'fetchAllQuotas' });
      break;
    case 'fetchQuota':
      if (id) {
        state.quotaFetching = true;
        render();
        vscode.postMessage({ type: 'fetchQuota', value: id });
      }
      break;

    // Maintenance
    case 'maintenanceClearHistory':
      vscode.postMessage({ type: 'maintenanceClearHistory' });
      showToast('历史已清空');
      break;
    case 'maintenanceResetStats':
      vscode.postMessage({ type: 'maintenanceResetStats' });
      showToast('统计已重置');
      break;
  }
}

// ---- Utilities ----

function showToast(msg: string): void {
  state.notification = msg;
  render();
  setTimeout(() => { state.notification = undefined; render(); }, 2500);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ---- Message Handler ----

window.addEventListener('message', event => {
  const msg = event.data as { type: string; value: unknown };

  if (msg.type === 'bootstrap') {
    window.__AI_ECHO_BOOTSTRAP__ = msg.value as Bootstrap;
    render();
    return;
  }

  if (msg.type === 'status') {
    window.__AI_ECHO_BOOTSTRAP__.status = msg.value as BridgeStatus;
    render();
    return;
  }

  if (msg.type === 'waiting') {
    state.isWaiting = msg.value as boolean;
    render();
    return;
  }

  if (msg.type === 'importResult') {
    const r = msg.value as { added: number; skipped: number };
    showToast(`导入完成：${r.added} 个成功，${r.skipped} 个跳过`);
    return;
  }

  if (msg.type === 'machineIdResult') {
    const r = msg.value as { success: boolean; message: string };
    showToast(r.message);
    return;
  }

  if (msg.type === 'quotaFetchResult') {
    state.quotaFetching = false;
    const r = msg.value as { success: boolean; error?: string };
    showToast(r.success ? '配额已更新' : `配额获取失败: ${r.error ?? '未知错误'}`);
    return;
  }

  if (msg.type === 'quotaFetchAllResult') {
    state.quotaFetching = false;
    const r = msg.value as { success: number; failed: number; errors: string[] };
    showToast(`配额刷新完成: ${r.success} 成功, ${r.failed} 失败`);
    return;
  }
});

render();
