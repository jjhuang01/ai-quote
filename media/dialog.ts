/**
 * Dialog Panel external script — loaded via <script nonce src> in the webview.
 *
 * Reads config from window.__DIALOG_CONFIG__ set by inline bootstrap:
 *   { sessionId: string, enterToSend: boolean, options: string[], queueCount: number }
 *
 * WHY external file?
 *   VS Code / Windsurf webview CSP requires nonce-based script-src.
 *   Inline scripts inside template literals also risk \n escaping bugs
 *   that silently break regex/string literals. External file avoids both.
 *   See docs/WEBVIEW_PITFALLS.md for details.
 */

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface DialogConfig {
  sessionId: string;
  enterToSend: boolean;
  options: string[];
  queueItems: string[];
}

interface Attachment {
  kind: 'image' | 'file';
  dataUri?: string;
  data: string;
  media_type: string;
  filename: string;
  size: number;
  preview?: string;      // UI preview (truncated for display)
  fullContent?: string;  // full text sent to LLM (up to 50KB)
}

// ── Bootstrap ──────────────────────────────────────────────────────
const vscode = acquireVsCodeApi();
const cfg: DialogConfig = (window as any).__DIALOG_CONFIG__ ?? {
  sessionId: '',
  enterToSend: false,
  options: [],
  queueItems: [],
};

// Local queue state (mutable, synced with extension)
const queue: string[] = [...(cfg.queueItems || [])];

// ── DOM refs ───────────────────────────────────────────────────────
const $id = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const tsEl = $id<HTMLSpanElement>('ts');
const replyEl = $id<HTMLTextAreaElement>('reply');
const dropZone = $id<HTMLDivElement>('dropZone');
const attachmentList = $id<HTMLDivElement>('attachmentList');
const attachCount = $id<HTMLSpanElement>('attachCount');
const queueBadge = $id<HTMLSpanElement>('queueBadge');
const queueListEl = $id<HTMLDivElement>('queueList');

// 对话已被 LLM 接收 — 后续发送走队列
let dialogResolved = false;
const copySummaryBtn = $id<HTMLButtonElement>('copySummary');

// Render timestamp
if (tsEl) tsEl.textContent = new Date().toLocaleTimeString();

// ── Attachment state ───────────────────────────────────────────────
const attachments: Attachment[] = [];

const TEXT_EXTS = [
  // Programming languages
  'js','ts','jsx','tsx','mjs','cjs','mts','cts',
  'py','pyw','rb','go','rs','java','kt','kts','scala','clj','cljs',
  'c','cpp','cc','cxx','h','hpp','hxx','cs','fs','fsx',
  'swift','m','mm','dart','lua','r','jl','ex','exs','erl','hrl','zig','nim','v',
  'php','pl','pm','tcl','awk','sed',
  // Web & markup
  'html','htm','xml','svg','xsl','xslt',
  'css','scss','sass','less','styl','stylus',
  'vue','svelte','astro','njk','ejs','hbs','pug','jade',
  // Data & config
  'json','jsonc','json5','yaml','yml','toml','ini','cfg','conf','properties',
  'csv','tsv','env',
  // Documentation
  'md','markdown','mdx','txt','rst','adoc','asciidoc','org','tex','bib',
  'log','diff','patch',
  // Shell & scripting
  'sh','bash','zsh','fish','ps1','psm1','bat','cmd',
  // Query & schema
  'sql','graphql','gql','prisma','proto','thrift','avsc',
  // Git & Docker dotfiles (extension after last dot)
  'gitignore','gitattributes','gitmodules','gitkeep',
  'dockerignore',
  // IDE & editor config dotfiles
  'editorconfig','eslintrc','prettierrc','stylelintrc','babelrc',
  'npmrc','nvmrc','yarnrc','node-version',
  // AI tool config files
  'cursorrules','windsurfrules','clinerules','mdc','mcp',
  // Build & infra
  'tf','tfvars','hcl','gradle','cmake',
  // No-extension filenames (split('.').pop() returns full lowercase name)
  'dockerfile','makefile','vagrantfile','gemfile','rakefile','procfile',
  'license','licence','authors','contributors','codeowners',
  'lock','snap',
];

// Special filenames that don't match by extension alone
const SPECIAL_FILENAMES = new Set([
  '.env.local','.env.development','.env.production','.env.test','.env.staging',
  'cmakelists.txt','go.sum','cargo.lock','pnpm-lock.yaml',
  'docker-compose.yml','docker-compose.yaml',
  '.prettierignore','.eslintignore','.gitignore','.dockerignore',
]);

function isTextFile(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  // Dotenv family: .env, .env.local, .env.production, etc.
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  // Special full-filename matches
  if (SPECIAL_FILENAMES.has(lower)) return true;
  // Extension-based check (also handles dotfiles like .gitignore → ext = "gitignore")
  const ext = lower.split('.').pop() ?? '';
  return TEXT_EXTS.includes(ext);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function fileExt(name: string): string {
  if (!name) return '';
  const parts = name.split('.');
  return parts.length > 1 ? (parts.pop()?.toLowerCase() ?? '') : '';
}

// ── Submit / Dismiss ───────────────────────────────────────────────
function send(response: string): void {
  const images = attachments
    .filter(a => a.kind === 'image')
    .map(a => ({ data: a.data, media_type: a.media_type, filename: a.filename || null }));
  vscode.postMessage({
    type: 'dialogSubmit',
    value: {
      sessionId: cfg.sessionId,
      response,
      images: images.length > 0 ? images : undefined,
    },
  });
}

function submitOption(idx: string): void {
  const text = cfg.options[Number(idx)] || '';
  if (dialogResolved) {
    if (text) { queue.push(text); syncQueueToExtension(); renderQueue(); showToast('已加入队列'); }
    return;
  }
  send(text);
}

function addToQueue(): void {
  const text = replyEl.value.trim();
  const hasImages = attachments.some(a => a.kind === 'image');
  let fileCtx = '';
  attachments.filter(a => a.kind === 'file').forEach(a => {
    const content = a.fullContent || a.preview || '';
    if (content) fileCtx += '\n\n--- ' + (a.filename || 'file') + ' ---\n' + content;
  });
  const combined = (text || '') + fileCtx;
  if (!combined.trim() && !hasImages) return;
  const queued = combined.trim() || '(attachment)';
  if (hasImages) showToast('图片无法入队列，仅文字内容已加入', 2500);
  queue.push(queued);
  replyEl.value = '';
  attachments.length = 0;
  renderAttachments();
  syncQueueToExtension();
  renderQueue();
  if (!hasImages) showToast('已加入队列 · 等待 LLM 就绪');
}

function submitCustom(): void {
  if (dialogResolved) { addToQueue(); return; }
  const text = replyEl.value.trim();
  if (!text && attachments.length === 0) return;
  let fileCtx = '';
  attachments.forEach(a => {
    if (a.kind === 'file') {
      const content = a.fullContent || a.preview || '';
      if (content) fileCtx += '\n\n--- ' + (a.filename || 'file') + ' ---\n' + content;
    }
  });
  let response = (text || '') + fileCtx;
  if (!response.trim()) response = '(attachment)';
  send(response.trim());
}

function dismiss(): void {
  vscode.postMessage({ type: 'dialogDismiss' });
}

// ── File reading ───────────────────────────────────────────────────
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function isDuplicate(file: File): boolean {
  return attachments.some(a => a.filename === file.name && a.size === file.size);
}

function addFile(file: File): void {
  if (!file) return;
  if (isDuplicate(file)) {
    showToast(`已存在: ${file.name}`, 1500);
    return;
  }
  const isImage = file.type?.startsWith('image/');
  const isText = isTextFile(file.name);

  if (isImage) {
    readFileAsDataURL(file).then(dataUri => {
      const parts = dataUri.split(',');
      const meta = parts[0];
      const base64 = parts[1];
      const mm = meta.match(/data:([^;]+)/);
      const mediaType = mm ? mm[1] : 'image/png';
      attachments.push({
        kind: 'image', dataUri, data: base64,
        media_type: mediaType, filename: file.name || 'image', size: file.size,
      });
      renderAttachments();
    });
  } else if (isText) {
    readFileAsText(file).then(text => {
      const maxLlm = 50_000; // 50KB limit for LLM
      const fullContent = text.length > maxLlm ? text.slice(0, maxLlm) + '\n... (truncated at 50KB)' : text;
      const preview = text.length > 2000 ? text.slice(0, 2000) + '\n... (truncated)' : text;
      attachments.push({
        kind: 'file', filename: file.name, size: file.size,
        preview, fullContent, media_type: 'text/plain', data: '',
      });
      renderAttachments();
    });
  } else {
    // Unsupported file type — show brief feedback
    showToast(`不支持的文件类型: ${file.name}`, 2500);
  }
}

// ── Toast feedback ─────────────────────────────────────────────────
function showToast(msg: string, duration = 2000): void {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('toast-show');
  setTimeout(() => toast!.classList.remove('toast-show'), duration);
}

// ── Attachment UI ──────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function removeAttachment(idx: number): void {
  attachments.splice(idx, 1);
  renderAttachments();
}

function renderAttachments(): void {
  attachmentList.innerHTML = '';
  attachments.forEach((a, i) => {
    const div = document.createElement('div');
    div.className = 'attach-item' + (a.kind === 'image' ? ' attach-image' : '');
    let html = '';
    if (a.kind === 'image' && a.dataUri) {
      html += '<img class="attach-thumb" src="' + a.dataUri + '" alt="">';
    } else {
      html += '<span class="attach-icon">📄</span>';
    }
    html += '<div class="attach-info">';
    html += '<div class="attach-name">' + esc(a.filename || 'file') + '</div>';
    html += '<div class="attach-meta">' + (a.kind === 'image' ? a.media_type : fileExt(a.filename).toUpperCase()) + ' · ' + formatSize(a.size || 0) + '</div>';
    if (a.kind === 'file' && a.preview) {
      html += '<div class="attach-preview">' + esc(a.preview.slice(0, 200)) + '</div>';
    }
    html += '</div>';
    div.innerHTML = html;
    const btn = document.createElement('button');
    btn.className = 'attach-remove';
    btn.textContent = '×';
    btn.onclick = () => removeAttachment(i);
    div.appendChild(btn);
    attachmentList.appendChild(div);
  });
  const n = attachments.length;
  attachCount.textContent = n > 0 ? n + ' 个附件' : '';
  dropZone.style.display = n > 0 ? 'none' : '';
}

// ── Browse files (reliable fallback for IDE drag-drop limitation) ──
const browseBtn = document.getElementById('browseBtn');
if (browseBtn) {
  browseBtn.addEventListener('click', (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'browseFiles' });
  });
}

// ── Drag & drop (counter-based to prevent child-element jitter) ───
let dragCounter = 0;

document.body.addEventListener('dragenter', (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
  dragCounter++;
  if (dragCounter === 1) {
    dropZone.classList.add('dragover');
    dropZone.style.display = '';
  }
});
document.body.addEventListener('dragover', (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
});
document.body.addEventListener('dragleave', (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropZone.classList.remove('dragover');
    if (attachments.length > 0) dropZone.style.display = 'none';
  }
});
document.body.addEventListener('drop', (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
  dragCounter = 0;
  dropZone.classList.remove('dragover');
  if (attachments.length > 0) dropZone.style.display = 'none';
});
document.body.addEventListener('drop', (e: DragEvent) => {
  // OS file manager drag: files are available directly
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    for (let i = 0; i < files.length; i++) addFile(files[i]);
    return;
  }
  // IDE explorer drag: files are empty, but text/uri-list has file:// URIs
  const uriList = e.dataTransfer?.getData('text/uri-list') || '';
  const textData = e.dataTransfer?.getData('text/plain') || '';
  const uris: string[] = [];
  if (uriList) {
    uriList.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) uris.push(trimmed);
    });
  } else if (textData) {
    textData.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('file://') || (trimmed.startsWith('/') && !trimmed.includes(' '))) {
        uris.push(trimmed.startsWith('file://') ? trimmed : 'file://' + trimmed);
      }
    });
  }
  if (uris.length > 0) {
    vscode.postMessage({ type: 'readFiles', value: uris });
    showToast(`正在读取 ${uris.length} 个文件...`);
  }
});

// ── Paste (images + files) ─────────────────────────────────────────
replyEl.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  let handled = false;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'file') {
      const file = items[i].getAsFile();
      if (file) { addFile(file); handled = true; }
    }
  }
  if (handled) e.preventDefault();
});

// ── Textarea drag visual (counter-based to prevent jitter) ───────
let textareaDragCounter = 0;
replyEl.addEventListener('dragenter', (e: DragEvent) => {
  e.preventDefault();
  textareaDragCounter++;
  if (textareaDragCounter === 1) replyEl.classList.add('drag-active');
});
replyEl.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); });
replyEl.addEventListener('dragleave', () => {
  textareaDragCounter--;
  if (textareaDragCounter <= 0) { textareaDragCounter = 0; replyEl.classList.remove('drag-active'); }
});
replyEl.addEventListener('drop', (e: DragEvent) => {
  e.preventDefault(); e.stopPropagation();
  textareaDragCounter = 0;
  replyEl.classList.remove('drag-active');
  dropZone.classList.remove('dragover');
  if (attachments.length > 0) dropZone.style.display = 'none';
  // OS file manager drag
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    for (let i = 0; i < files.length; i++) addFile(files[i]);
    return;
  }
  // IDE explorer drag (same logic as body handler)
  const uriList = e.dataTransfer?.getData('text/uri-list') || '';
  const textData = e.dataTransfer?.getData('text/plain') || '';
  const uris: string[] = [];
  if (uriList) {
    uriList.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) uris.push(trimmed);
    });
  } else if (textData) {
    textData.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('file://') || (trimmed.startsWith('/') && !trimmed.includes(' '))) {
        uris.push(trimmed.startsWith('file://') ? trimmed : 'file://' + trimmed);
      }
    });
  }
  if (uris.length > 0) {
    vscode.postMessage({ type: 'readFiles', value: uris });
    showToast(`正在读取 ${uris.length} 个文件...`);
  }
});

// ── Character count ──────────────────────────────────────────────
const charCountEl = $id<HTMLSpanElement>('charCount');
if (replyEl && charCountEl) {
  replyEl.addEventListener('input', () => {
    const len = replyEl.value.length;
    charCountEl.textContent = `${len} 字`;
  });
}

// ── Send key handler ──────────────────────────────────────────────
replyEl.addEventListener('keydown', (e: KeyboardEvent) => {
  if (cfg.enterToSend) {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      submitCustom();
    }
  } else {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submitCustom();
    }
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (dialogResolved) { vscode.postMessage({ type: 'dialogClose' }); } else { dismiss(); }
  }
});

// ── Copy summary ──────────────────────────────────────────────────
if (copySummaryBtn) {
  copySummaryBtn.addEventListener('click', () => {
    const summaryEl = $id<HTMLDivElement>('summary');
    const text = summaryEl ? (summaryEl.innerText || summaryEl.textContent || '') : '';
    navigator.clipboard.writeText(text).then(() => {
      copySummaryBtn.textContent = '✓ 已复制';
      copySummaryBtn.classList.add('copied');
      setTimeout(() => { copySummaryBtn.textContent = '复制'; copySummaryBtn.classList.remove('copied'); }, 1500);
    }).catch(() => { /* clipboard API may not be available */ });
  });
}

// ── Action buttons (data-action) ──────────────────────────────────
document.querySelectorAll('[data-action]').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.getAttribute('data-action');
    if (action === 'submitCustom') submitCustom();
    else if (action === 'dismiss') dismiss();
    else if (action === 'cancelDialog') cancelDialog();
    else if (action === 'submitOption') submitOption(btn.getAttribute('data-idx') || '0');
  });
});

function cancelDialog(): void {
  const msg = dialogResolved
    ? '确定要关闭对话框吗？'
    : '确定要取消本次回复吗？LLM 将收到空回复（dismiss）。';
  if (!confirm(msg)) return;
  if (dialogResolved) {
    vscode.postMessage({ type: 'dialogClose' });
  } else {
    dismiss();
  }
}

// ── Queue management ──────────────────────────────────────────────

function syncQueueToExtension(): void {
  vscode.postMessage({ type: 'queueUpdate', value: [...queue] });
}

function renderQueue(): void {
  if (queueBadge) queueBadge.textContent = String(queue.length);
  if (!queueListEl) return;
  if (queue.length === 0) {
    queueListEl.innerHTML = '<div class="queue-empty">队列为空</div>';
    return;
  }
  queueListEl.innerHTML = '';
  queue.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.setAttribute('data-idx', String(i));
    // Number label
    const num = document.createElement('span');
    num.className = 'queue-item-num';
    num.textContent = `${i + 1}.`;
    row.appendChild(num);
    // Content preview
    const content = document.createElement('div');
    content.className = 'queue-item-content';
    content.textContent = item.length > 80 ? item.slice(0, 80) + '…' : item;
    content.title = item;
    row.appendChild(content);
    // Action buttons (edit + delete only, compact)
    const actions = document.createElement('div');
    actions.className = 'queue-item-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'queue-act'; editBtn.textContent = '✎'; editBtn.title = '编辑';
    editBtn.onclick = () => startEditQueueItem(i);
    actions.appendChild(editBtn);
    const delBtn = document.createElement('button');
    delBtn.className = 'queue-act queue-act-danger'; delBtn.textContent = '×'; delBtn.title = '删除';
    delBtn.onclick = () => { queue.splice(i, 1); syncQueueToExtension(); renderQueue(); };
    actions.appendChild(delBtn);
    row.appendChild(actions);
    queueListEl.appendChild(row);
  });
}

function startEditQueueItem(idx: number): void {
  if (!queueListEl) return;
  const row = queueListEl.querySelector(`[data-idx="${idx}"]`);
  if (!row) return;
  row.innerHTML = '';
  row.className = 'queue-item queue-item-editing';
  const ta = document.createElement('textarea');
  ta.className = 'queue-edit-input';
  ta.value = queue[idx];
  ta.rows = 2;
  row.appendChild(ta);
  const btnRow = document.createElement('div');
  btnRow.className = 'queue-item-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'queue-act'; saveBtn.textContent = '✓'; saveBtn.title = '保存';
  saveBtn.onclick = () => {
    const v = ta.value.trim();
    if (v) { queue[idx] = v; syncQueueToExtension(); }
    renderQueue();
  };
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'queue-act'; cancelBtn.textContent = '✗'; cancelBtn.title = '取消';
  cancelBtn.onclick = () => renderQueue();
  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);
  row.appendChild(btnRow);
  ta.focus();
}

// ── Queue toggle & clear all ────────────────────────────────────
const queueToggleBtn = document.getElementById('queueToggle');
const queueClearAllBtn = document.getElementById('queueClearAll');
if (queueToggleBtn && queueListEl) {
  queueToggleBtn.addEventListener('click', () => {
    queueListEl.classList.toggle('collapsed');
    queueToggleBtn.textContent = queueListEl.classList.contains('collapsed') ? '▶' : '▼';
  });
}
if (queueClearAllBtn) {
  queueClearAllBtn.addEventListener('click', () => {
    if (queue.length === 0) return;
    queue.length = 0;
    syncQueueToExtension();
    renderQueue();
    showToast('队列已清空');
  });
}

// Listen for messages from extension
window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  if (!msg) return;
  // Dialog resolved — keep input active for queue, show small status row
  if (msg.type === 'dialogResolved') {
    dialogResolved = true;
    const header = document.querySelector('.header-icon');
    const title = document.querySelector('.header-title');
    if (header) header.textContent = '✓';
    if (title) title.textContent = '已发送 · 等待 LLM 处理';
    // Change send button to queue mode (don't disable)
    const sendBtn = document.querySelector('.btn-send') as HTMLButtonElement | null;
    if (sendBtn) {
      sendBtn.textContent = '➕ 加入队列';
      sendBtn.style.background = 'var(--surface)';
      sendBtn.style.color = 'var(--fg)';
      sendBtn.style.boxShadow = 'none';
      sendBtn.style.border = '1px solid var(--border)';
      sendBtn.style.fontSize = '13px';
      sendBtn.style.padding = '10px 0';
      sendBtn.style.fontWeight = '500';
    }
    // Transform shortcut-bar into small inline "已发送 [关闭]" row
    const shortcutBar = document.querySelector('.shortcut-bar') as HTMLElement | null;
    if (shortcutBar) {
      shortcutBar.innerHTML = '';
      shortcutBar.classList.add('sent-bar');
      const status = document.createElement('span');
      status.className = 'sent-status';
      status.textContent = '✓ 已发送 · 等待 LLM 处理';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn-close-inline';
      closeBtn.textContent = '关闭';
      closeBtn.addEventListener('click', () => vscode.postMessage({ type: 'dialogClose' }));
      shortcutBar.appendChild(status);
      shortcutBar.appendChild(closeBtn);
    }
    // Update textarea placeholder to guide user
    if (replyEl) replyEl.placeholder = '继续输入，发送后加入队列...';
    return;
  }
  if (msg.type === 'queueSync') {
    const items = msg.value as string[];
    if (Array.isArray(items)) {
      queue.length = 0;
      queue.push(...items);
      renderQueue();
    }
  }
  // Legacy: queueCount (if sidebar only sends count)
  if (msg.type === 'queueCount' && queueBadge) {
    queueBadge.textContent = String(msg.value || 0);
  }
  // IDE file read results (from text/uri-list drag or browse)
  if (msg.type === 'readFileResult') {
    const result = msg.value as {
      filename: string; content: string; size: number;
      isImage: boolean; dataUri?: string; mediaType?: string; error?: string;
    };
    if (result.error) {
      showToast(`读取失败: ${result.filename} — ${result.error}`, 3000);
      return;
    }
    if (attachments.some(a => a.filename === result.filename && a.size === result.size)) {
      showToast(`已存在: ${result.filename}`, 1500);
      return;
    }
    if (result.isImage && result.dataUri) {
      const parts = result.dataUri.split(',');
      const base64 = parts[1] || '';
      attachments.push({
        kind: 'image', dataUri: result.dataUri, data: base64,
        media_type: result.mediaType || 'image/png',
        filename: result.filename, size: result.size,
      });
    } else {
      const maxLlm = 50_000;
      const fullContent = result.content.length > maxLlm
        ? result.content.slice(0, maxLlm) + '\n... (truncated at 50KB)'
        : result.content;
      const preview = result.content.length > 2000
        ? result.content.slice(0, 2000) + '\n... (truncated)'
        : result.content;
      attachments.push({
        kind: 'file', filename: result.filename, size: result.size,
        preview, fullContent, media_type: 'text/plain', data: '',
      });
    }
    renderAttachments();
  }
});

// Initial render
renderQueue();

// ── Focus textarea ────────────────────────────────────────────────
setTimeout(() => { replyEl?.focus(); }, 100);
