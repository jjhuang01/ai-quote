import { randomBytes } from 'node:crypto';
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
  private onQueueAdd?: (items: string[]) => void;
  private onQueueReplace?: (items: string[]) => void;
  private submitted = false;
  private enterToSend = false;
  private queueCount = 0;
  private queueItems: string[] = [];

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
        this.onSubmit?.(sid, response, images.length > 0 ? images : undefined);
      }
      if (msg.type === 'dialogDismiss') {
        this.dismissAndResolve();
      }
      if (msg.type === 'queueAdd') {
        const items = msg.value as string[];
        if (items?.length) this.onQueueAdd?.(items);
      }
      if (msg.type === 'queueUpdate') {
        const items = msg.value as string[];
        if (Array.isArray(items)) {
          this.queueItems = items;
          this.queueCount = items.length;
          this.onQueueReplace?.(items);
        }
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
    onSubmit: DialogSubmitHandler,
    options?: { enterToSend?: boolean; queueCount?: number; queueItems?: string[]; onQueueAdd?: (items: string[]) => void; onQueueReplace?: (items: string[]) => void }
  ): void {
    if (QuoteDialogPanel.instance) {
      QuoteDialogPanel.instance.onSubmit = onSubmit;
      QuoteDialogPanel.instance.enterToSend = options?.enterToSend ?? false;
      QuoteDialogPanel.instance.queueCount = options?.queueCount ?? 0;
      QuoteDialogPanel.instance.queueItems = options?.queueItems ?? [];
      QuoteDialogPanel.instance.onQueueAdd = options?.onQueueAdd;
      QuoteDialogPanel.instance.onQueueReplace = options?.onQueueReplace;
      QuoteDialogPanel.instance.update(req);
      QuoteDialogPanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const inst = new QuoteDialogPanel(extensionUri, onSubmit);
    inst.enterToSend = options?.enterToSend ?? false;
    inst.queueCount = options?.queueCount ?? 0;
    inst.queueItems = options?.queueItems ?? [];
    inst.onQueueAdd = options?.onQueueAdd;
    inst.onQueueReplace = options?.onQueueReplace;
    QuoteDialogPanel.instance = inst;
    inst.update(req);
  }

  /** Update queue display from outside (e.g. when sidebar queue changes). */
  public static updateQueueCount(count: number): void {
    if (QuoteDialogPanel.instance) {
      QuoteDialogPanel.instance.queueCount = count;
    }
  }

  /** Sync full queue items to dialog webview. */
  public static syncQueueItems(items: string[]): void {
    if (QuoteDialogPanel.instance) {
      QuoteDialogPanel.instance.queueItems = items;
      QuoteDialogPanel.instance.queueCount = items.length;
      try {
        void QuoteDialogPanel.instance.panel.webview.postMessage({ type: 'queueSync', value: items });
      } catch { /* panel may be disposed */ }
    }
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
    const nonce = randomBytes(16).toString('hex');
    const dialogScriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'dialog.js')
    );

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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${this.panel.webview.cspSource} data:; font-src data:;">
<title>Quote Dialog</title>
<style>
  :root {
    --bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #1a1a1a));
    --fg: var(--vscode-foreground, #e6e6e6);
    --muted: var(--vscode-descriptionForeground, #848484);
    --border: var(--vscode-panel-border, #383838);
    --border-subtle: color-mix(in srgb, var(--border) 48%, transparent);
    --input-bg: var(--vscode-input-background, #2e2e2e);
    --input-fg: var(--vscode-input-foreground, #e6e6e6);
    --input-border: var(--vscode-input-border, #555);
    --btn-bg: var(--vscode-button-background, #0e639c);
    --btn-fg: var(--vscode-button-foreground, #fff);
    --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
    --card: var(--vscode-editorWidget-background, #252525);
    --accent: var(--vscode-button-background, #0e639c);
    --accent-subtle: color-mix(in srgb, var(--accent) 12%, transparent);
    --surface: var(--vscode-input-background, #2e2e2e);
    --surface-hover: color-mix(in srgb, var(--accent) 10%, var(--surface));
    --code-bg: var(--vscode-textCodeBlock-background, #1e1e1e);
    --success: #22c55e;
    --danger: #ef4444;
    --danger-subtle: color-mix(in srgb, #ef4444 14%, transparent);
    --radius: 6px;
    --font: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
    --mono: var(--vscode-editor-font-family, 'SF Mono', Menlo, monospace);
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
    gap: 10px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: linear-gradient(180deg, color-mix(in srgb, var(--card) 100%, transparent), var(--bg));
    backdrop-filter: blur(4px);
  }
  .header-icon {
    width: 30px; height: 30px;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, var(--accent-subtle), color-mix(in srgb, var(--accent) 20%, transparent));
    border-radius: 8px;
    font-size: 14px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  }
  .header-title { font-weight: 600; font-size: 13px; flex: 1; letter-spacing: -0.01em; }
  .header-ts { font-size: 11px; color: var(--muted); }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .summary {
    line-height: 1.65;
    max-height: 50vh;
    overflow-y: auto;
    padding: 14px 16px;
    background: linear-gradient(135deg, var(--card), color-mix(in srgb, var(--card) 85%, var(--bg)));
    border-radius: 8px;
    border: 1px solid var(--border-subtle);
    font-size: 13px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.03);
  }
  .summary pre { white-space: pre-wrap; word-break: break-word; }
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
  .options { display: flex; flex-wrap: wrap; gap: 6px; }
  .opt-btn {
    padding: 6px 14px;
    background: linear-gradient(180deg, var(--surface), color-mix(in srgb, var(--surface) 80%, var(--bg)));
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 12px;
    font-family: var(--font);
    transition: all 0.15s ease;
    box-shadow: 0 1px 2px rgba(0,0,0,0.08);
  }
  .opt-btn:hover { background: var(--surface-hover); border-color: var(--accent); box-shadow: 0 1px 4px rgba(0,0,0,0.15); }
  .input-section { display: flex; flex-direction: column; gap: 6px; }
  .input-label { font-size: 11px; color: var(--muted); }
  textarea {
    width: 100%;
    min-height: 80px;
    resize: vertical;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 8px;
    padding: 10px 12px;
    font-family: var(--font);
    font-size: 13px;
    line-height: 1.5;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-subtle); }
  textarea.drag-active { border-color: var(--accent); background: var(--accent-subtle); }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .btn-primary {
    padding: 7px 20px;
    background: linear-gradient(180deg, var(--btn-bg), color-mix(in srgb, var(--btn-bg) 80%, #000));
    color: var(--btn-fg);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 12px;
    font-family: var(--font);
    font-weight: 600;
    transition: all 0.15s;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    letter-spacing: 0.02em;
  }
  .btn-primary:hover { background: var(--btn-hover); box-shadow: 0 2px 6px rgba(0,0,0,0.3); transform: translateY(-0.5px); }
  .btn-cancel {
    padding: 7px 16px;
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    cursor: pointer;
    font-size: 12px;
    font-family: var(--font);
    transition: all 0.15s;
  }
  .btn-cancel:hover { color: var(--fg); border-color: var(--border); background: var(--danger-subtle); }
  .hint { font-size: 11px; color: var(--muted); margin-left: auto; }
  /* Drop zone & attachments */
  .drop-zone {
    border: 1.5px dashed var(--border);
    border-radius: 8px;
    padding: 12px;
    text-align: center;
    font-size: 11px;
    color: var(--muted);
    transition: all 0.2s;
    cursor: pointer;
  }
  .drop-zone.dragover {
    border-color: var(--accent);
    color: var(--fg);
    background: var(--accent-subtle);
  }
  .drop-zone:hover {
    border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
    color: var(--fg);
  }
  .attachment-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .attach-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    font-size: 12px;
  }
  .attach-item.attach-image {
    align-items: flex-start;
  }
  .attach-thumb {
    width: 48px; height: 48px;
    border-radius: 3px;
    object-fit: cover;
    flex-shrink: 0;
    border: 1px solid var(--border-subtle);
  }
  .attach-icon {
    width: 20px; height: 20px;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; flex-shrink: 0;
    opacity: 0.6;
  }
  .attach-info { flex: 1; min-width: 0; }
  .attach-name {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .attach-meta { font-size: 10px; color: var(--muted); }
  .attach-preview {
    font-size: 11px;
    color: var(--muted);
    font-family: var(--mono);
    max-height: 42px;
    overflow: hidden;
    white-space: pre;
    text-overflow: ellipsis;
    margin-top: 2px;
    line-height: 1.4;
  }
  .attach-remove {
    width: 20px; height: 20px;
    background: none; border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 14px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 3px;
    flex-shrink: 0;
    transition: all 0.15s;
  }
  .attach-remove:hover { color: var(--danger); background: var(--danger-subtle); }
  .attach-count { font-size: 11px; color: var(--muted); }
  /* Copy button */
  .copy-btn {
    position: absolute; top: 6px; right: 6px;
    padding: 3px 8px;
    background: var(--surface); border: 1px solid var(--border-subtle);
    border-radius: 4px; cursor: pointer;
    font-size: 11px; color: var(--muted);
    opacity: 0; transition: opacity 0.15s;
    font-family: var(--font);
  }
  .summary-wrap { position: relative; }
  .summary-wrap:hover .copy-btn { opacity: 1; }
  .copy-btn:hover { color: var(--fg); border-color: var(--accent); background: var(--accent-subtle); }
  .copy-btn.copied { color: var(--success); border-color: var(--success); }
  /* Queue section */
  .queue-section {
    background: var(--card);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 10px 14px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  .queue-header {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; font-weight: 600; margin-bottom: 8px;
  }
  .queue-badge {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 18px; height: 18px; padding: 0 5px;
    background: var(--accent); color: var(--btn-fg);
    border-radius: 9px; font-size: 10px; font-weight: 700;
  }
  .queue-input-row { display: flex; gap: 6px; }
  .queue-input {
    flex: 1; min-height: 32px; resize: none;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 6px;
    padding: 6px 8px; font-family: var(--font); font-size: 12px;
    line-height: 1.4; outline: none;
    transition: border-color 0.15s;
  }
  .queue-input:focus { border-color: var(--accent); }
  .queue-input::placeholder { color: var(--muted); }
  .btn-queue-add {
    padding: 4px 12px; white-space: nowrap;
    background: var(--surface); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px;
    cursor: pointer; font-size: 11px; font-family: var(--font);
    transition: all 0.15s;
  }
  .btn-queue-add:hover { border-color: var(--accent); background: var(--accent-subtle); }
  .queue-hint { font-size: 10px; color: var(--muted); margin-top: 4px; }
  /* Queue list */
  .queue-list-container { margin-top: 8px; max-height: 200px; overflow-y: auto; }
  .queue-item {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 8px; background: var(--surface);
    border: 1px solid var(--border-subtle); border-radius: 4px;
    margin-bottom: 3px; font-size: 12px;
  }
  .queue-item-editing { flex-direction: column; align-items: stretch; }
  .queue-item-content {
    flex: 1; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: default;
  }
  .queue-item-actions { display: flex; gap: 2px; flex-shrink: 0; }
  .queue-act {
    width: 22px; height: 22px;
    background: none; border: 1px solid transparent;
    color: var(--muted); cursor: pointer;
    font-size: 12px; border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.12s;
  }
  .queue-act:hover { color: var(--fg); border-color: var(--border); background: var(--surface-hover); }
  .queue-act-danger:hover { color: var(--danger); border-color: var(--danger); background: var(--danger-subtle); }
  .queue-edit-input {
    width: 100%; min-height: 28px; resize: vertical;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 4px;
    padding: 4px 6px; font-family: var(--font); font-size: 12px;
    outline: none;
  }
  .queue-edit-input:focus { border-color: var(--accent); }
  .queue-empty { font-size: 11px; color: var(--muted); padding: 6px 0; text-align: center; }
  .queue-clear-row { text-align: right; padding-top: 4px; }
  /* Toast */
  .toast {
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%) translateY(20px);
    background: var(--card); color: var(--fg); border: 1px solid var(--border);
    padding: 6px 16px; border-radius: 6px; font-size: 12px;
    opacity: 0; pointer-events: none; transition: all 0.25s ease;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 100;
  }
  .toast-show { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>
<div class="header">
  <span class="header-icon">⏸</span>
  <span class="header-title">LLM 等待回复</span>
  <span class="header-ts" id="ts"></span>
</div>
<div class="body">
  <div class="summary-wrap">
    ${summaryHtml}
    <button class="copy-btn" id="copySummary" title="复制 LLM 摘要">复制</button>
  </div>
  ${optionBtns ? `<div class="options">${optionBtns}</div>` : ''}
  <div class="input-section">
    <div class="input-label">回复内容 · ${this.enterToSend ? 'Enter' : 'Ctrl+Enter'} 发送 · 支持拖拽 / 粘贴文件与图片</div>
    <textarea id="reply" placeholder="输入回复… (${this.enterToSend ? 'Enter 发送, Shift+Enter 换行' : 'Ctrl+Enter 发送'})" autofocus></textarea>
  </div>
  <div id="dropZone" class="drop-zone">拖拽文件或图片到此处 · 支持 js / ts / md / json / txt 等常用文件</div>
  <div id="attachmentList" class="attachment-list"></div>
  <div class="actions">
    <button class="btn-primary" data-action="submitCustom">发送</button>
    <button class="btn-cancel" data-action="dismiss">取消</button>
    <span id="attachCount" class="attach-count"></span>
    <span class="hint">Esc 取消 · ${this.enterToSend ? 'Enter' : 'Ctrl+Enter'} 发送</span>
  </div>
  <div class="queue-section">
    <div class="queue-header">无人值守队列 <span class="queue-badge" id="queueBadge">${this.queueCount}</span></div>
    <div class="queue-input-row">
      <textarea class="queue-input" id="queueInput" placeholder="输入预设回复… 多条用 --- 分隔" rows="2"></textarea>
      <button class="btn-queue-add" id="queueAddBtn">加入队列</button>
    </div>
    <div class="queue-hint">提示：队列中的回复会在 LLM 下次调用时自动发送，实现无人值守。多条用 <code>---</code> 分隔。Ctrl+Enter 快速添加。</div>
    <div class="queue-list-container" id="queueList"></div>
  </div>
</div>
<script nonce="${nonce}">
  window.__DIALOG_CONFIG__ = {
    sessionId: ${sessionId},
    enterToSend: ${this.enterToSend ? 'true' : 'false'},
    options: ${safeJsonEmbed(req.options ?? [])},
    queueItems: ${safeJsonEmbed(this.queueItems)}
  };
</script>
<script nonce="${nonce}" src="${dialogScriptUri}"></script>
</body>
</html>`;
  }
}
