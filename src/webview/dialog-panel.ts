import * as vscode from 'vscode';
import type { McpDialogRequest, ImageAttachment } from '../core/contracts';

export type DialogSubmitHandler = (sessionId: string, response: string, images?: ImageAttachment[]) => void;

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Safely embed a value inside a <script> block — escapes </ sequences that would prematurely close the tag. */
function safeJsonEmbed(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

/** Server-side markdown → HTML renderer (no external deps). */
function renderMarkdown(md: string): string {
  // 1. Extract fenced code blocks
  const codeBlocks: string[] = [];
  let src = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(
      `<pre><code class="lang-${escHtml(lang || 'text')}">${escHtml(code.trimEnd())}</code></pre>`,
    );
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract inline code
  const inlineCodes: string[] = [];
  src = src.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${escHtml(code)}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Inline formatting helper (bold, italic, links) — operates on already-escaped text
  const inlineFmt = (t: string): string =>
    escHtml(t)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 3. Process lines
  const lines = src.split('\n');
  const out: string[] = [];
  let listTag = '';
  let inTable = false;

  const closeList = () => { if (listTag) { out.push(`</${listTag}>`); listTag = ''; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code-block placeholder
    const cbMatch = line.match(/^\x00CB(\d+)\x00$/);
    if (cbMatch) { closeList(); closeTable(); out.push(codeBlocks[+cbMatch[1]]); continue; }

    // Heading
    const hMatch = line.match(/^(#{1,6}) (.+)$/);
    if (hMatch) { closeList(); closeTable(); out.push(`<h${hMatch[1].length}>${inlineFmt(hMatch[2])}</h${hMatch[1].length}>`); continue; }

    // HR
    if (/^-{3,}$/.test(line.trim())) { closeList(); closeTable(); out.push('<hr>'); continue; }

    // Blockquote
    if (line.startsWith('> ')) { closeList(); closeTable(); out.push(`<blockquote>${inlineFmt(line.slice(2))}</blockquote>`); continue; }

    // Unordered list
    const ulMatch = line.match(/^[-*] (.+)$/);
    if (ulMatch) { closeTable(); if (listTag !== 'ul') { closeList(); out.push('<ul>'); listTag = 'ul'; } out.push(`<li>${inlineFmt(ulMatch[1])}</li>`); continue; }

    // Ordered list
    const olMatch = line.match(/^\d+\. (.+)$/);
    if (olMatch) { closeTable(); if (listTag !== 'ol') { closeList(); out.push('<ol>'); listTag = 'ol'; } out.push(`<li>${inlineFmt(olMatch[1])}</li>`); continue; }

    // Table
    if (line.includes('|') && line.trim().startsWith('|')) {
      if (/^\|[-: |]+\|$/.test(line.trim())) continue; // separator
      closeList();
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      const next = lines[i + 1] || '';
      if (/^\|[-: |]+\|$/.test(next.trim())) {
        closeTable();
        out.push('<table><thead><tr>' + cells.map(c => `<th>${inlineFmt(c)}</th>`).join('') + '</tr></thead><tbody>');
        inTable = true; i++;
      } else if (inTable) {
        out.push('<tr>' + cells.map(c => `<td>${inlineFmt(c)}</td>`).join('') + '</tr>');
      }
      continue;
    }

    closeList(); closeTable();
    if (!line.trim()) continue;
    out.push(`<p>${inlineFmt(line)}</p>`);
  }
  closeList(); closeTable();

  // 4. Restore placeholders
  let html = out.join('\n');
  codeBlocks.forEach((cb, i) => { html = html.replace(`\x00CB${i}\x00`, cb); });
  inlineCodes.forEach((ic, i) => { html = html.replace(`\x00IC${i}\x00`, ic); });
  return html;
}

/**
 * QuoteDialogPanel opens a focused WebviewPanel in the editor area (center tab)
 * when the LLM calls the MCP tool, instead of showing in the sidebar.
 * Reuses the same panel across calls — just updates content.
 */
export class QuoteDialogPanel {
  private static instance?: QuoteDialogPanel;

  private panel: vscode.WebviewPanel;
  private currentReq?: McpDialogRequest;
  private onSubmit?: DialogSubmitHandler;
  private submitted = false;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    onSubmit: DialogSubmitHandler
  ) {
    this.onSubmit = onSubmit;
    this.panel = vscode.window.createWebviewPanel(
      'quoteDialog',
      '⏸ Quote — 等待回复',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')]
      }
    );

    this.panel.webview.onDidReceiveMessage((msg: { type: string; value?: unknown }) => {
      if (msg.type === 'dialogSubmit' && this.currentReq && !this.submitted) {
        this.submitted = true;
        const payload = msg.value as { sessionId?: string; response?: string; images?: ImageAttachment[] } | undefined;
        const response = payload?.response ?? '';
        const images = payload?.images ?? [];
        const sid = payload?.sessionId ?? this.currentReq.sessionId;
        // onSubmit triggers resolvePendingDialog → dialogResolvedCallback → QuoteDialogPanel.dispose()
        // so we must NOT access this.panel after onSubmit returns
        this.onSubmit?.(sid, response, images.length > 0 ? images : undefined);
      }
      if (msg.type === 'dialogDismiss') {
        this.dismissAndResolve();
      }
    });

    this.panel.onDidDispose(() => {
      // Panel closed via tab X button — resolve with dismiss if not already submitted
      this.dismissAndResolve();
      QuoteDialogPanel.instance = undefined;
    });
  }

  public static show(
    extensionUri: vscode.Uri,
    req: McpDialogRequest,
    onSubmit: DialogSubmitHandler
  ): void {
    if (QuoteDialogPanel.instance) {
      QuoteDialogPanel.instance.onSubmit = onSubmit;
      QuoteDialogPanel.instance.update(req);
      QuoteDialogPanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const inst = new QuoteDialogPanel(extensionUri, onSubmit);
    QuoteDialogPanel.instance = inst;
    inst.update(req);
  }

  public static dispose(): void {
    QuoteDialogPanel.instance?.panel.dispose();
    QuoteDialogPanel.instance = undefined;
  }

  /** Mark the current dialog as externally submitted so dispose won't re-resolve. */
  public static markSubmitted(): void {
    if (QuoteDialogPanel.instance) {
      QuoteDialogPanel.instance.submitted = true;
    }
  }

  private dismissAndResolve(): void {
    if (this.submitted || !this.currentReq) return;
    this.submitted = true;
    const sid = this.currentReq.sessionId;
    this.onSubmit?.(sid, '(dismissed)');
  }

  private update(req: McpDialogRequest): void {
    this.submitted = false;
    this.currentReq = req;
    this.panel.title = '⏸ Quote — 等待回复';
    this.panel.webview.html = this.buildHtml(req);
  }

  private buildHtml(req: McpDialogRequest): string {
    const optionBtns = (req.options ?? [])
      .map(
        (opt, i) =>
          `<button class="opt-btn" data-action="submitOption" data-idx="${i}">${escHtml(opt)}</button>`
      )
      .join('');

    const summaryContent = req.isMarkdown !== false
      ? renderMarkdown(req.summary)
      : `<pre>${escHtml(req.summary)}</pre>`;
    const summaryHtml = `<div id="summary" class="summary${req.isMarkdown !== false ? ' md' : ''}">${summaryContent}</div>`;

    const sessionId = safeJsonEmbed(req.sessionId);

    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<title>Quote Dialog</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border, #444);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #555);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --opt-bg: var(--vscode-badge-background, #3a3d41);
    --opt-fg: var(--vscode-badge-foreground, #fff);
    --accent: var(--vscode-focusBorder, #007acc);
    --code-bg: var(--vscode-textCodeBlock-background, #1e1e1e);
    --radius: 6px;
    --font: var(--vscode-font-family, system-ui, sans-serif);
    --mono: var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font);
    font-size: 13px;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .header-icon { font-size: 16px; }
  .header-title { font-weight: 600; font-size: 14px; flex: 1; }
  .header-ts { font-size: 11px; opacity: 0.5; }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .summary {
    line-height: 1.6;
    max-height: 55vh;
    overflow-y: auto;
    padding: 12px 14px;
    background: var(--code-bg);
    border-radius: var(--radius);
    border: 1px solid var(--border);
  }
  .summary pre { white-space: pre-wrap; word-break: break-word; }
  /* basic markdown styles */
  .summary.md h1,.summary.md h2,.summary.md h3 { margin: 8px 0 4px; font-weight: 600; }
  .summary.md h1 { font-size: 1.3em; }
  .summary.md h2 { font-size: 1.15em; }
  .summary.md h3 { font-size: 1em; }
  .summary.md p { margin-bottom: 8px; }
  .summary.md ul,.summary.md ol { padding-left: 20px; margin-bottom: 8px; }
  .summary.md li { margin-bottom: 2px; }
  .summary.md code { background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 3px; font-family: var(--mono); font-size: 0.9em; }
  .summary.md pre { background: rgba(0,0,0,0.3); padding: 10px; border-radius: 4px; overflow-x: auto; }
  .summary.md pre code { background: none; padding: 0; }
  .summary.md strong,.summary.md b { font-weight: 600; }
  .summary.md em,.summary.md i { font-style: italic; }
  .summary.md a { color: var(--accent); }
  .summary.md blockquote { border-left: 3px solid var(--accent); padding-left: 10px; opacity: 0.8; margin: 8px 0; }
  .summary.md hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
  .summary.md table { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
  .summary.md th,.summary.md td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
  .summary.md th { background: rgba(255,255,255,0.05); }
  .options { display: flex; flex-wrap: wrap; gap: 8px; }
  .opt-btn {
    padding: 6px 14px;
    background: var(--opt-bg);
    color: var(--opt-fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 13px;
    font-family: var(--font);
    transition: background 0.15s;
  }
  .opt-btn:hover { background: var(--btn-hover); color: var(--btn-fg); border-color: var(--accent); }
  .input-section { display: flex; flex-direction: column; gap: 8px; }
  .input-label { font-size: 11px; opacity: 0.6; }
  textarea {
    width: 100%;
    min-height: 80px;
    resize: vertical;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: var(--radius);
    padding: 8px 10px;
    font-family: var(--font);
    font-size: 13px;
    line-height: 1.5;
    outline: none;
  }
  textarea:focus { border-color: var(--accent); }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .btn-primary {
    padding: 7px 18px;
    background: var(--btn-bg);
    color: var(--btn-fg);
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 13px;
    font-family: var(--font);
    font-weight: 500;
  }
  .btn-primary:hover { background: var(--btn-hover); }
  .btn-secondary {
    padding: 7px 14px;
    background: transparent;
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 13px;
    font-family: var(--font);
    opacity: 0.7;
  }
  .btn-secondary:hover { opacity: 1; border-color: var(--accent); }
  .hint { font-size: 11px; opacity: 0.45; margin-left: auto; }
  /* Image upload styles */
  .drop-zone {
    border: 2px dashed var(--border);
    border-radius: var(--radius);
    padding: 12px;
    text-align: center;
    font-size: 12px;
    opacity: 0.6;
    transition: border-color 0.2s, opacity 0.2s;
    cursor: pointer;
  }
  .drop-zone.dragover {
    border-color: var(--accent);
    opacity: 1;
    background: rgba(0,122,204,0.08);
  }
  .image-previews {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .image-preview {
    position: relative;
    width: 80px;
    height: 80px;
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid var(--border);
  }
  .image-preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .image-preview .remove-btn {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    background: rgba(0,0,0,0.7);
    color: #fff;
    border: none;
    border-radius: 50%;
    font-size: 11px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  .image-preview .remove-btn:hover { background: #c00; }
  .image-count { font-size: 11px; opacity: 0.5; }
</style>
</head>
<body>
<div class="header">
  <span class="header-icon">⏸</span>
  <span class="header-title">LLM 等待您的回复</span>
  <span class="header-ts" id="ts"></span>
</div>
<div class="body">
  ${summaryHtml}
  ${optionBtns ? `<div class="options">${optionBtns}</div>` : ''}
  <div class="input-section">
    <div class="input-label">自定义回复（Ctrl+Enter 发送 · 可粘贴或拖拽图片）</div>
    <textarea id="reply" placeholder="输入回复内容…" autofocus></textarea>
  </div>
  <div id="dropZone" class="drop-zone">拖拽图片到此处，或在输入框中粘贴 (Ctrl+V)</div>
  <div id="imagePreviews" class="image-previews"></div>
  <div class="actions">
    <button class="btn-primary" data-action="submitCustom">✓ 发送</button>
    <button class="btn-secondary" data-action="dismiss">忽略</button>
    <span id="imageCount" class="image-count"></span>
    <span class="hint">Ctrl+Enter 快速发送</span>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const SESSION_ID = ${sessionId};

// Render timestamp
document.getElementById('ts').textContent = new Date().toLocaleTimeString();

// --- Image state ---
const uploadedImages = []; // Array of { dataUri, data, media_type, filename }

function submitOption(idx) {
  var opts = ${safeJsonEmbed(req.options ?? [])};
  var text = opts[Number(idx)] || '';
  send(text);
}

function submitCustom() {
  const text = document.getElementById('reply').value.trim();
  if (!text && uploadedImages.length === 0) return;
  send(text || '(image attachment)');
}

function dismiss() {
  vscode.postMessage({ type: 'dialogDismiss' });
}

function send(response) {
  const images = uploadedImages.map(function(img) {
    return { data: img.data, media_type: img.media_type, filename: img.filename || null };
  });
  vscode.postMessage({ type: 'dialogSubmit', value: { sessionId: SESSION_ID, response: response, images: images } });
}

// --- Image handling ---
function fileToBase64(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() { resolve(reader.result); };
    reader.onerror = function() { reject(reader.error); };
    reader.readAsDataURL(file);
  });
}

function addImageFromFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  fileToBase64(file).then(function(dataUri) {
    var parts = dataUri.split(',');
    var meta = parts[0]; // data:image/png;base64
    var base64 = parts[1];
    var mediaMatch = meta.match(/data:([^;]+)/);
    var mediaType = mediaMatch ? mediaMatch[1] : 'image/png';
    uploadedImages.push({ dataUri: dataUri, data: base64, media_type: mediaType, filename: file.name || null });
    renderImagePreviews();
  });
}

function removeImage(idx) {
  uploadedImages.splice(idx, 1);
  renderImagePreviews();
}

function renderImagePreviews() {
  var container = document.getElementById('imagePreviews');
  var countEl = document.getElementById('imageCount');
  container.innerHTML = '';
  uploadedImages.forEach(function(img, i) {
    var wrap = document.createElement('div');
    wrap.className = 'image-preview';
    var imgEl = document.createElement('img');
    imgEl.src = img.dataUri;
    imgEl.alt = img.filename || 'image';
    wrap.appendChild(imgEl);
    var btn = document.createElement('button');
    btn.className = 'remove-btn';
    btn.textContent = 'x';
    btn.onclick = function() { removeImage(i); };
    wrap.appendChild(btn);
    container.appendChild(wrap);
  });
  countEl.textContent = uploadedImages.length > 0 ? uploadedImages.length + ' image(s)' : '';
  document.getElementById('dropZone').style.display = uploadedImages.length > 0 ? 'none' : '';
}

// Drag & drop
var dropZone = document.getElementById('dropZone');
['dragenter', 'dragover'].forEach(function(evt) {
  document.body.addEventListener(evt, function(e) {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('dragover');
    dropZone.style.display = '';
  });
});
['dragleave', 'drop'].forEach(function(evt) {
  document.body.addEventListener(evt, function(e) {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
    if (uploadedImages.length > 0) dropZone.style.display = 'none';
  });
});
document.body.addEventListener('drop', function(e) {
  var files = e.dataTransfer ? e.dataTransfer.files : [];
  for (var i = 0; i < files.length; i++) { addImageFromFile(files[i]); }
});

// Paste
document.getElementById('reply').addEventListener('paste', function(e) {
  var items = e.clipboardData ? e.clipboardData.items : [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image') !== -1) {
      var file = items[i].getAsFile();
      if (file) addImageFromFile(file);
    }
  }
});

document.getElementById('reply').addEventListener('keydown', function(e) {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    submitCustom();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    dismiss();
  }
});

// Bind action buttons via addEventListener (safer than inline onclick in webview)
document.querySelectorAll('[data-action]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var action = btn.getAttribute('data-action');
    if (action === 'submitCustom') submitCustom();
    else if (action === 'dismiss') dismiss();
    else if (action === 'submitOption') submitOption(btn.getAttribute('data-idx'));
  });
});

// Focus textarea
setTimeout(function() { document.getElementById('reply').focus(); }, 100);
</script>
</body>
</html>`;
  }
}
