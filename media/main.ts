import './main.css';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

declare global {
  interface Window {
    __AI_ECHO_BOOTSTRAP__: {
      status: {
        running: boolean;
        port: number;
        toolName: string;
        currentIde: string;
        messageCount: number;
        sseClientCount: number;
        autoConfiguredPaths: string[];
        lastConfiguredAt?: string;
      };
      logPath: string;
      history: HistoryItem[];
      queue: QueueItem[];
      accounts: AccountInfo[];
      feedback: FeedbackItem[];
    };
  }
}

interface HistoryItem {
  id: string;
  type: 'conversation' | 'feedback' | 'event';
  title: string;
  content: string;
  createdAt: string;
}

interface QueueItem {
  id: string;
  type: 'message' | 'feedback' | 'event' | 'command';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: string;
}

interface AccountInfo {
  id: string;
  email?: string;
  displayName?: string;
  provider: string;
}

interface FeedbackItem {
  id: string;
  rating: 'positive' | 'negative' | 'neutral';
  comment?: string;
  createdAt: string;
}

const vscode = acquireVsCodeApi();
let state = {
  activeTab: 'status' as 'status' | 'history' | 'queue' | 'feedback' | 'settings',
  searchQuery: '',
  isWaiting: false,
  expandedHistoryId: undefined as string | undefined
};

function render(): void {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) return;

  const bootstrap = window.__AI_ECHO_BOOTSTRAP__;
  
  root.innerHTML = `
    <main class="echo-shell">
      ${renderHeader(bootstrap)}
      ${renderSearchBar()}
      ${renderTabNav()}
      ${renderActiveTab(bootstrap)}
    </main>
  `;

  bindEvents();
}

function renderHeader(bootstrap: Window['__AI_ECHO_BOOTSTRAP__']): string {
  return `
    <header class="echo-header">
      <div>
        <p class="eyebrow">AI Echo Rebuild</p>
        <h1>Bridge ready on ${bootstrap.status.port}</h1>
        <p class="subtle">${bootstrap.status.currentIde} · ${bootstrap.status.toolName}</p>
      </div>
      <span class="status-pill ${bootstrap.status.running ? 'online' : 'offline'}">
        ${bootstrap.status.running ? 'Online' : 'Offline'}
      </span>
    </header>
  `;
}

function renderSearchBar(): string {
  return `
    <div class="search-bar">
      <span>🔍</span>
      <input type="text" placeholder="Search history, feedback..." value="${state.searchQuery}" data-action="search">
    </div>
  `;
}

function renderTabNav(): string {
  const tabs = [
    { id: 'status', label: 'Status' },
    { id: 'history', label: 'History' },
    { id: 'queue', label: 'Queue' },
    { id: 'feedback', label: 'Feedback' },
    { id: 'settings', label: 'Settings' }
  ];
  
  return `
    <nav class="tab-nav">
      ${tabs.map(tab => `
        <button class="tab-btn ${state.activeTab === tab.id ? 'active' : ''}" data-tab="${tab.id}">
          ${tab.label}
        </button>
      `).join('')}
    </nav>
  `;
}

function renderActiveTab(bootstrap: Window['__AI_ECHO_BOOTSTRAP__']): string {
  switch (state.activeTab) {
    case 'status': return renderStatusTab(bootstrap);
    case 'history': return renderHistoryTab(bootstrap);
    case 'queue': return renderQueueTab(bootstrap);
    case 'feedback': return renderFeedbackTab(bootstrap);
    case 'settings': return renderSettingsTab(bootstrap);
    default: return '';
  }
}

function renderStatusTab(bootstrap: Window['__AI_ECHO_BOOTSTRAP__']): string {
  const stats = bootstrap.status;
  
  return `
    <div class="tab-content" data-tab="status">
      ${state.isWaiting ? renderWaitingCard() : ''}
      
      <section class="card">
        <h2>Quick actions</h2>
        <div class="actions">
          <button data-action="refresh">Refresh</button>
          <button data-action="testFeedback">Test feedback</button>
          <button data-action="openLogFile">Open logs</button>
          <button data-action="clearQueue">Clear queue</button>
        </div>
      </section>

      <section class="card">
        <h2>Stats</h2>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value">${stats.port}</div>
            <div class="stat-label">Port</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.sseClientCount}</div>
            <div class="stat-label">SSE Clients</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.messageCount}</div>
            <div class="stat-label">Messages</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.autoConfiguredPaths.length}</div>
            <div class="stat-label">Configs</div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Configured paths</h2>
        <ul class="paths">
          ${stats.autoConfiguredPaths.length > 0 
            ? stats.autoConfiguredPaths.map(p => `<li>${p}</li>`).join('')
            : '<li class="empty-state">No auto-configured paths yet.</li>'
          }
        </ul>
        <p class="hint">Log file: ${bootstrap.logPath}</p>
      </section>
    </div>
  `;
}

function renderHistoryTab(bootstrap: Window['__AI_ECHO_BOOTSTRAP__']): string {
  const items = state.searchQuery 
    ? bootstrap.history.filter(h => 
        h.title.toLowerCase().includes(state.searchQuery.toLowerCase()) ||
        h.content.toLowerCase().includes(state.searchQuery.toLowerCase())
      )
    : bootstrap.history;

  return `
    <div class="tab-content" data-tab="history">
      <section class="card">
        <h2>History</h2>
        <div class="history-section">
          ${items.length > 0 
            ? items.map(item => renderHistoryItem(item)).join('')
            : '<p class="empty-state">No history yet.</p>'
          }
        </div>
      </section>
    </div>
  `;
}

function renderHistoryItem(item: HistoryItem): string {
  const icon = item.type === 'conversation' ? '💬' : item.type === 'feedback' ? '⭐' : '📡';
  const time = new Date(item.createdAt).toLocaleString();
  const isExpanded = state.expandedHistoryId === item.id;
  
  return `
    <div class="history-item" data-history-id="${item.id}">
      <div class="history-icon">${icon}</div>
      <div class="history-content">
        <p class="history-title">${escapeHtml(item.title)}</p>
        <p class="history-meta">${item.type} · ${time}</p>
      </div>
    </div>
    <div class="history-detail ${isExpanded ? 'open' : ''}" data-detail-id="${item.id}">
      ${escapeHtml(item.content)}
    </div>
  `;
}

function renderQueueTab(bootstrap: Window['__AI_ECHO_BOOTSTRAP__']): string {
  const queue = bootstrap.queue;
  const pending = queue.filter(q => q.status === 'pending');
  const processing = queue.filter(q => q.status === 'processing');
  const completed = queue.filter(q => q.status === 'completed');
  const failed = queue.filter(q => q.status === 'failed');

  return `
    <div class="tab-content" data-tab="queue">
      <section class="card">
        <div class="queue-head">
          <h2>Queue</h2>
          <button class="queue-clear" data-action="clearQueue">Clear completed</button>
        </div>
        <div class="queue-section">
          ${queue.length > 0 
            ? queue.map(item => `
              <div class="queue-item ${item.status}">
                <span>${item.type}</span>
                <span>${item.status}</span>
                <span style="color: var(--muted)">${new Date(item.createdAt).toLocaleTimeString()}</span>
              </div>
            `).join('')
            : '<p class="empty-state">Queue is empty.</p>'
          }
        </div>
      </section>
    </div>
  `;
}

function renderFeedbackTab(bootstrap: Window['__AI_ECHO_BOOTSTRAP__']): string {
  const stats = {
    total: bootstrap.feedback.length,
    positive: bootstrap.feedback.filter(f => f.rating === 'positive').length,
    negative: bootstrap.feedback.filter(f => f.rating === 'negative').length,
    neutral: bootstrap.feedback.filter(f => f.rating === 'neutral').length
  };

  return `
    <div class="tab-content" data-tab="feedback">
      <section class="card">
        <h2>Feedback Stats</h2>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value">${stats.total}</div>
            <div class="stat-label">Total</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" style="color: var(--success)">${stats.positive}</div>
            <div class="stat-label">Positive</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" style="color: var(--danger)">${stats.negative}</div>
            <div class="stat-label">Negative</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.neutral}</div>
            <div class="stat-label">Neutral</div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Recent Feedback</h2>
        <div class="feedback-wrapper">
          ${bootstrap.feedback.length > 0 
            ? bootstrap.feedback.slice(0, 10).map(item => `
              <div class="feedback-item">
                <span class="feedback-rating ${item.rating}">
                  ${item.rating === 'positive' ? '👍' : item.rating === 'negative' ? '👎' : '😐'}
                </span>
                <span class="feedback-content">${escapeHtml(item.comment || 'No comment')}</span>
              </div>
            `).join('')
            : '<p class="empty-state">No feedback yet.</p>'
          }
        </div>
      </section>
    </div>
  `;
}

function renderSettingsTab(bootstrap: Window['__AI_ECHO_BOOTSTRAP__']): string {
  const account = bootstrap.accounts[0];
  
  return `
    <div class="tab-content" data-tab="settings">
      <section class="card">
        <h2>Account</h2>
        <div class="account-section">
          ${account 
            ? `
              <div class="account-item">
                <div class="account-avatar">${(account.displayName || account.email || '?')[0].toUpperCase()}</div>
                <div class="account-info">
                  <p class="account-name">${escapeHtml(account.displayName || account.email || 'Unknown')}</p>
                  <p class="account-provider">${account.provider}</p>
                </div>
              </div>
            `
            : '<p class="empty-state">No account configured.</p>'
          }
        </div>
      </section>

      <section class="card">
        <h2>Configuration</h2>
        <div class="settings-section">
          <div class="setting-row">
            <span class="setting-label">Server Port</span>
            <span class="setting-value">${bootstrap.status.port}</span>
          </div>
          <div class="setting-row">
            <span class="setting-label">IDE</span>
            <span class="setting-value">${bootstrap.status.currentIde}</span>
          </div>
          <div class="setting-row">
            <span class="setting-label">Tool Name</span>
            <span class="setting-value">${bootstrap.status.toolName}</span>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Parity Status</h2>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <span class="status-badge proven">✓ Proven features</span>
          <span class="status-badge inferred">⚡ Inferred features</span>
        </div>
        <p class="hint" style="margin-top: 12px">See docs/evidence/parity-matrix.md for details.</p>
      </section>
    </div>
  `;
}

function renderWaitingCard(): string {
  return `
    <div class="waiting-card">
      <div class="waiting-spinner"></div>
      <span class="waiting-text">Processing...</span>
    </div>
  `;
}

function bindEvents(): void {
  // Tab navigation
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab as typeof state.activeTab;
      if (tab) {
        state.activeTab = tab;
        render();
      }
    });
  });

  // Search
  const searchInput = document.querySelector<HTMLInputElement>('[data-action="search"]');
  searchInput?.addEventListener('input', (e) => {
    state.searchQuery = (e.target as HTMLInputElement).value;
    render();
  });

  // History items
  document.querySelectorAll<HTMLDivElement>('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.historyId;
      if (id) {
        state.expandedHistoryId = state.expandedHistoryId === id ? undefined : id;
        render();
      }
    });
  });

  // Action buttons
  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(btn => {
    const action = btn.dataset.action;
    if (action && !['search'].includes(action)) {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: action });
      });
    }
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Handle messages from extension
window.addEventListener('message', event => {
  const message = event.data;
  
  if (message.type === 'status') {
    window.__AI_ECHO_BOOTSTRAP__.status = message.value;
    render();
  }
  
  if (message.type === 'history') {
    window.__AI_ECHO_BOOTSTRAP__.history = message.value;
    render();
  }
  
  if (message.type === 'queue') {
    window.__AI_ECHO_BOOTSTRAP__.queue = message.value;
    render();
  }
  
  if (message.type === 'feedback') {
    window.__AI_ECHO_BOOTSTRAP__.feedback = message.value;
    render();
  }
  
  if (message.type === 'waiting') {
    state.isWaiting = message.value;
    render();
  }
});

// Initial render
render();
