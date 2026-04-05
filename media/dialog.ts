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
  queueCount: number;
}

interface Attachment {
  kind: 'image' | 'file';
  dataUri?: string;
  data: string;
  media_type: string;
  filename: string;
  size: number;
  preview?: string;
}

// ── Bootstrap ──────────────────────────────────────────────────────
const vscode = acquireVsCodeApi();
const cfg: DialogConfig = (window as any).__DIALOG_CONFIG__ ?? {
  sessionId: '',
  enterToSend: false,
  options: [],
  queueCount: 0,
};

// ── DOM refs ───────────────────────────────────────────────────────
const $id = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const tsEl = $id<HTMLSpanElement>('ts');
const replyEl = $id<HTMLTextAreaElement>('reply');
const dropZone = $id<HTMLDivElement>('dropZone');
const attachmentList = $id<HTMLDivElement>('attachmentList');
const attachCount = $id<HTMLSpanElement>('attachCount');
const queueBadge = $id<HTMLSpanElement>('queueBadge');
const queueInput = $id<HTMLTextAreaElement>('queueInput');
const queueAddBtn = $id<HTMLButtonElement>('queueAddBtn');
const copySummaryBtn = $id<HTMLButtonElement>('copySummary');

// Render timestamp
if (tsEl) tsEl.textContent = new Date().toLocaleTimeString();

// ── Attachment state ───────────────────────────────────────────────
const attachments: Attachment[] = [];

const TEXT_EXTS = [
  'js','ts','jsx','tsx','mjs','cjs','json','md','markdown','txt','css','scss',
  'less','html','htm','xml','yaml','yml','toml','ini','cfg','conf','sh','bash',
  'zsh','py','rb','go','rs','java','c','cpp','h','hpp','swift','kt','sql',
  'graphql','gql','vue','svelte','astro','env','gitignore','dockerignore',
  'dockerfile','makefile','csv','tsv','log','diff','patch',
];

function isTextFile(name: string): boolean {
  if (!name) return false;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
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
  send(text);
}

function submitCustom(): void {
  const text = replyEl.value.trim();
  if (!text && attachments.length === 0) return;
  let fileCtx = '';
  attachments.forEach(a => {
    if (a.kind === 'file' && a.preview) {
      fileCtx += '\n\n--- ' + (a.filename || 'file') + ' ---\n' + a.preview;
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

function addFile(file: File): void {
  if (!file) return;
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
      const preview = text.length > 2000 ? text.slice(0, 2000) + '\n... (truncated)' : text;
      attachments.push({
        kind: 'file', filename: file.name, size: file.size,
        preview, media_type: 'text/plain', data: '',
      });
      renderAttachments();
    });
  }
  // Unsupported types silently ignored
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

// ── Drag & drop ────────────────────────────────────────────────────
['dragenter', 'dragover'].forEach(evt => {
  document.body.addEventListener(evt, (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('dragover');
    dropZone.style.display = '';
  });
});
['dragleave', 'drop'].forEach(evt => {
  document.body.addEventListener(evt, (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
    if (attachments.length > 0) dropZone.style.display = 'none';
  });
});
document.body.addEventListener('drop', (e: DragEvent) => {
  const files = e.dataTransfer?.files;
  if (files) {
    for (let i = 0; i < files.length; i++) addFile(files[i]);
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

// ── Textarea drag visual ──────────────────────────────────────────
replyEl.addEventListener('dragenter', (e: DragEvent) => { e.preventDefault(); replyEl.classList.add('drag-active'); });
replyEl.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); });
replyEl.addEventListener('dragleave', () => { replyEl.classList.remove('drag-active'); });
replyEl.addEventListener('drop', (e: DragEvent) => {
  e.preventDefault(); e.stopPropagation();
  replyEl.classList.remove('drag-active');
  const files = e.dataTransfer?.files;
  if (files) {
    for (let i = 0; i < files.length; i++) addFile(files[i]);
  }
});

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
    dismiss();
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
    else if (action === 'submitOption') submitOption(btn.getAttribute('data-idx') || '0');
  });
});

// ── Queue management ──────────────────────────────────────────────
if (queueAddBtn && queueInput) {
  queueAddBtn.addEventListener('click', () => {
    const raw = queueInput.value.trim();
    if (!raw) return;
    // Split by --- on its own line
    const SEPARATOR = /\n---\n|\n---$|^---\n/;
    const items = raw.split(SEPARATOR).map(s => s.trim()).filter(Boolean);
    if (items.length === 0) return;
    vscode.postMessage({ type: 'queueAdd', value: items });
    queueInput.value = '';
    const cur = parseInt(queueBadge.textContent || '0', 10) || 0;
    queueBadge.textContent = String(cur + items.length);
  });
}

// Listen for queueCount updates from extension
window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  if (msg && msg.type === 'queueCount' && queueBadge) {
    queueBadge.textContent = String(msg.value || 0);
  }
});

// ── Focus textarea ────────────────────────────────────────────────
setTimeout(() => { replyEl?.focus(); }, 100);
